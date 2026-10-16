import { assert } from "@std/assert";
import type { OpenAIClients, UserOpenAIClients } from "./ai/clients.ts";
import type { AIProvider, AIUsage, EmbeddingProvider, EmbeddingRequest, StructuredRequest } from "./ai/provider.ts";

export interface FakeAIProvider extends AIProvider {
  calls: StructuredRequest<unknown>[];
}

/**
 * Returns `respond(request)` validated against the request's schema, like the real provider.
 * A thrown error (or returned Error) is rethrown as-is.
 */
export function createFakeAIProvider(
  respond: (request: StructuredRequest<unknown>) => unknown,
  usage: AIUsage = { input_tokens: 100, cached_input_tokens: 0, output_tokens: 50 },
): FakeAIProvider {
  const calls: StructuredRequest<unknown>[] = [];
  return {
    calls,
    generateStructured<T>(request: StructuredRequest<T>) {
      calls.push(request as StructuredRequest<unknown>);
      try {
        const value = respond(request as StructuredRequest<unknown>);
        if (value instanceof Error) {
          return Promise.reject(value);
        }
        return Promise.resolve({ output: request.schema.parse(value), usage });
      } catch (err) {
        return Promise.reject(err);
      }
    },
  };
}

/** A deterministic vector derived from `text`, so equal inputs embed equally. */
export function fakeEmbedding(text: string, dimensions = 1536): number[] {
  let h = 2166136261;
  for (const c of text) {
    h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  }
  return Array.from({ length: dimensions }, (_, i) => ((h + i * 2654435761) % 1000) / 1000);
}

export interface FakeEmbeddingProvider extends EmbeddingProvider {
  calls: EmbeddingRequest[];
}

/**
 * Returns `respond(request)` (default: `fakeEmbedding` per input) with 7 input tokens per input.
 * A thrown or returned Error is rethrown as-is; a returned promise is awaited, so tests can delay.
 */
export function createFakeEmbeddingProvider(
  respond: (request: EmbeddingRequest) => number[][] | Error | Promise<number[][] | Error> = (r) => r.input.map((t) => fakeEmbedding(t)),
): FakeEmbeddingProvider {
  const calls: EmbeddingRequest[] = [];
  return {
    calls,
    async embed(request) {
      calls.push(request);
      const value = await respond(request);
      if (value instanceof Error) {
        throw value;
      }
      return { embeddings: value, usage: { input_tokens: 7 * request.input.length } };
    },
  };
}

export const FAKE_CREDENTIAL_ID = "c0c0c0c0-0000-4000-8000-00000000c0de";

function refused(kind: string): Error {
  return new Error(`${kind} was not expected in this test`);
}

/** One user's clients; anything not given refuses every call. */
export function fakeUserOpenAIClients(parts: Partial<UserOpenAIClients> = {}): UserOpenAIClients {
  return {
    credentialId: FAKE_CREDENTIAL_ID,
    ai: createFakeAIProvider(() => refused("an AI call")),
    embeddings: createFakeEmbeddingProvider(() => refused("an embedding call")),
    realtime: {
      createClientSecret: () => Promise.reject(refused("a Realtime mint")),
      createTranscriptionClientSecret: () => Promise.reject(refused("a transcription mint")),
    },
    ...parts,
  };
}

export interface FakeOpenAIClients extends OpenAIClients {
  /** User ids `forUser` was called with, in order. */
  calls: string[];
}

/**
 * Serves `clients` (or the error it returns) for `ownerId` only. Any other user id throws a plain
 * Error, so a test fails loudly if the wrong account's key would be used.
 */
export function createFakeOpenAIClients(
  ownerId: string,
  clients: UserOpenAIClients | Error | (() => UserOpenAIClients | Error) = fakeUserOpenAIClients(),
): FakeOpenAIClients {
  const calls: string[] = [];
  return {
    calls,
    forUser(userId) {
      calls.push(userId);
      if (userId !== ownerId) {
        return Promise.reject(new Error(`forUser called for ${userId}, expected the owner ${ownerId}`));
      }
      const value = typeof clients === "function" ? clients() : clients;
      return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
    },
  };
}

const FORBIDDEN = ["token", "access_token", "refresh_token", "client_secret", "private_key", "ghs_", "ghu_", "gho_"];

/** Fails if the response body or headers contain anything token-like. Consumes a clone of the body. */
export async function assertNoSecrets(res: Response): Promise<void> {
  const body = await res.clone().text();
  const headers = JSON.stringify([...res.headers.entries()]);
  for (const haystack of [body, headers]) {
    const lower = haystack.toLowerCase();
    for (const needle of FORBIDDEN) {
      assert(!lower.includes(needle), `response leaks "${needle}": ${haystack}`);
    }
  }
}
