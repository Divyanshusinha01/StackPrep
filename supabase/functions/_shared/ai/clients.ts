import type { OpenAIKeyStatus } from "@stackprep/shared";
import { createRealtimeClient, type RealtimeClient } from "../realtime/openai-realtime.ts";
import {
  type KeyFailure,
  keyFailureOf,
  type OpenAICredentialResolver,
  OpenAIKeyUnusableError,
  unusableStatusOf,
} from "./credentials.ts";
import { createOpenAIEmbeddingProvider, createOpenAIProvider, createOpenAIWebSearchProvider } from "./openai.ts";
import type { AIProvider, EmbeddingProvider, WebSearchProvider } from "./provider.ts";

/** OpenAI clients bound to one user's decrypted key. Never cache across requests or steps. */
export interface UserOpenAIClients {
  credentialId: string;
  ai: AIProvider;
  embeddings: EmbeddingProvider;
  search: WebSearchProvider;
  realtime: RealtimeClient;
}

export interface OpenAIClients {
  /** `userId` must be the authenticated user or an owner id loaded from the database, never request input. */
  forUser(userId: string): Promise<UserOpenAIClients>;
}

/** Builds the provider for an API key; the only place a key reaches an `Authorization` header. */
export interface OpenAIClientFactories {
  ai(apiKey: string): AIProvider;
  embeddings(apiKey: string): EmbeddingProvider;
  search(apiKey: string): WebSearchProvider;
  realtime(apiKey: string): RealtimeClient;
}

/** `aiTimeoutMs` is the fallback for structured calls; embeddings and Realtime keep their own defaults. */
export function openAIClientFactories({ aiTimeoutMs }: { aiTimeoutMs?: number } = {}): OpenAIClientFactories {
  return {
    ai: (apiKey) => createOpenAIProvider({ apiKey, timeoutMs: aiTimeoutMs }),
    embeddings: (apiKey) => createOpenAIEmbeddingProvider({ apiKey }),
    search: (apiKey) => createOpenAIWebSearchProvider({ apiKey }),
    realtime: (apiKey) => createRealtimeClient({ apiKey }),
  };
}

type LogEntry = Record<string, string | number | boolean | null>;

export interface OpenAIClientsOptions {
  log?: (entry: LogEntry) => void;
}

function defaultLog(entry: LogEntry): void {
  console.warn(JSON.stringify(entry));
}

/**
 * Wraps each provider so a key failure (401, 403, model access, insufficient_quota) flips the stored
 * status. The compare-and-set on `credentialId` keeps a stale call from marking a replaced key.
 */
export function createOpenAIClients(
  resolver: OpenAICredentialResolver,
  factories: OpenAIClientFactories,
  { log = defaultLog }: OpenAIClientsOptions = {},
): OpenAIClients {
  return {
    async forUser(userId) {
      const { apiKey, credentialId } = await resolver.resolve(userId);

      async function guard<T>(call: () => Promise<T>): Promise<T> {
        try {
          return await call();
        } catch (err) {
          const failure = keyFailureOf(err);
          if (failure) {
            await mark(failure);
          }
          throw err;
        }
      }

      async function mark({ status, code }: KeyFailure): Promise<void> {
        try {
          await resolver.markStatus(userId, credentialId, status, code);
        } catch {
          log({ event: "openai_key_status_update_failed", status });
        }
      }

      const ai = factories.ai(apiKey);
      const embeddings = factories.embeddings(apiKey);
      const search = factories.search(apiKey);
      const realtime = factories.realtime(apiKey);
      return {
        credentialId,
        ai: { generateStructured: (request) => guard(() => ai.generateStructured(request)) },
        embeddings: { embed: (request) => guard(() => embeddings.embed(request)) },
        search: { searchWeb: (request) => guard(() => search.searchWeb(request)) },
        realtime: {
          createClientSecret: (session, id) => guard(() => realtime.createClientSecret(session, id)),
          createTranscriptionClientSecret: (session, id) => guard(() => realtime.createTranscriptionClientSecret(session, id)),
        },
      };
    },
  };
}

export type OpenAIKeyApiErrorCode = "openai_key_required" | "openai_key_invalid" | "openai_key_permission_denied" | "openai_quota_exhausted";

/** HTTP error code for a missing/unusable key or a key failure from OpenAI; null for anything else. */
export function openAIKeyApiErrorCode(err: unknown): OpenAIKeyApiErrorCode | null {
  switch (unusableStatusOf(err)) {
    case "missing":
      return "openai_key_required";
    case "invalid":
      return "openai_key_invalid";
    case "permission_denied":
      return "openai_key_permission_denied";
    case "quota_exhausted":
      return "openai_quota_exhausted";
    default:
      return null;
  }
}

/** Gate for routes that queue AI work: the code for a missing or unusable stored key, null when valid. */
export function keyStatusApiErrorCode(status: OpenAIKeyStatus | null): OpenAIKeyApiErrorCode | null {
  if (status === null) {
    return "openai_key_required";
  }
  return status === "valid" ? null : openAIKeyApiErrorCode(new OpenAIKeyUnusableError(status));
}

export type OpenAIKeyJobErrorCode = "openai_key_unavailable" | "openai_key_invalid" | "openai_quota_exhausted";

/** Non-retriable job code for a missing/unusable key or a key failure from OpenAI; null for anything else. */
export function openAIKeyJobErrorCode(err: unknown): OpenAIKeyJobErrorCode | null {
  switch (unusableStatusOf(err)) {
    case "missing":
      return "openai_key_unavailable";
    case "invalid":
    case "permission_denied":
      return "openai_key_invalid";
    case "quota_exhausted":
      return "openai_quota_exhausted";
    default:
      return null;
  }
}
