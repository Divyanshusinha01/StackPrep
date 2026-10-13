import { z } from "zod";
import type { RealtimeFunctionTool } from "./tools.ts";

const CLIENT_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets";
const DEFAULT_TIMEOUT_MS = 15_000;
/** Only needs to outlive the browser's SDP exchange; reconnects mint a new one. */
export const CREDENTIAL_TTL_SECONDS = 60;
const VOICE = "marin";

export interface RealtimeSessionInput {
  model: string;
  instructions: string;
  tools: RealtimeFunctionTool[];
}

/** Transcription-only session on the same microphone track; the browser commits each turn. */
export interface TranscriptionSessionInput {
  model: string;
}

export interface RealtimeCredential {
  value: string;
  expiresAt: Date;
}

export interface RealtimeClient {
  /** `safetyIdentifier` is a stable, non-reversible id for the end user. */
  createClientSecret(session: RealtimeSessionInput, safetyIdentifier: string): Promise<RealtimeCredential>;
  createTranscriptionClientSecret(session: TranscriptionSessionInput, safetyIdentifier: string): Promise<RealtimeCredential>;
}

/** Carries the upstream status only, never the response body or the API key. */
export class RealtimeUnavailableError extends Error {
  override readonly name = "RealtimeUnavailableError";

  constructor(readonly status?: number) {
    super(status === undefined ? "Realtime request failed" : `Realtime request failed with status ${status}`);
  }
}

const clientSecretResponseSchema = z.object({
  value: z.string().min(1),
  expires_at: z.number().int().positive(),
});

const EXPIRES_AFTER = { anchor: "created_at", seconds: CREDENTIAL_TTL_SECONDS };

/** The candidate's transcript comes from the separate transcription session, not this one. */
export function buildClientSecretRequest(session: RealtimeSessionInput): Record<string, unknown> {
  return {
    expires_after: EXPIRES_AFTER,
    session: {
      type: "realtime",
      model: session.model,
      instructions: session.instructions,
      output_modalities: ["audio"],
      audio: {
        input: {
          noise_reduction: { type: "near_field" },
          turn_detection: { type: "server_vad", create_response: true, interrupt_response: true },
        },
        output: { voice: VOICE },
      },
      tools: session.tools,
      tool_choice: "auto",
      truncation: "auto",
    },
  };
}

/** `turn_detection` must be null: the browser commits on the voice session's `speech_stopped`. */
export function buildTranscriptionClientSecretRequest(session: TranscriptionSessionInput): Record<string, unknown> {
  return {
    expires_after: EXPIRES_AFTER,
    session: {
      type: "transcription",
      audio: {
        input: {
          noise_reduction: { type: "near_field" },
          transcription: { model: session.model },
          turn_detection: null,
        },
      },
    },
  };
}

export function createRealtimeClient(
  { apiKey, fetch: fetchFn = fetch, timeoutMs = DEFAULT_TIMEOUT_MS }: {
    apiKey: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
  },
): RealtimeClient {
  async function mint(body: Record<string, unknown>, safetyIdentifier: string): Promise<RealtimeCredential> {
    let res: Response;
    try {
      res = await fetchFn(CLIENT_SECRETS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "OpenAI-Safety-Identifier": safetyIdentifier,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new RealtimeUnavailableError();
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new RealtimeUnavailableError(res.status);
    }
    const parsed = clientSecretResponseSchema.safeParse(await res.json().catch(() => null));
    if (!parsed.success) {
      throw new RealtimeUnavailableError(res.status);
    }
    return { value: parsed.data.value, expiresAt: new Date(parsed.data.expires_at * 1000) };
  }

  return {
    createClientSecret: (session, safetyIdentifier) => mint(buildClientSecretRequest(session), safetyIdentifier),
    createTranscriptionClientSecret: (session, safetyIdentifier) =>
      mint(buildTranscriptionClientSecretRequest(session), safetyIdentifier),
  };
}
