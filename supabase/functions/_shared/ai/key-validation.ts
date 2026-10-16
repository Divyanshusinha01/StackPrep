import type { OpenAIKeyErrorCode } from "@stackprep/shared";
import { createRealtimeClient, RealtimeUnavailableError } from "../realtime/openai-realtime.ts";
import { keyFailureOf, type UnusableKeyStatus } from "./credentials.ts";
import { classifyOpenAIFailure, readErrorCode, retryAfterSeconds } from "./openai-errors.ts";
import { createOpenAIEmbeddingProvider } from "./openai.ts";
import { AIRateLimitedError } from "./provider.ts";

const MODELS_URL = "https://api.openai.com/v1/models/";
const DEFAULT_TIMEOUT_MS = 10_000;

export interface KeyValidationModels {
  /** Every configured model; duplicates are checked once. */
  models: string[];
  embeddingModel: string;
  transcriptionModel: string;
}

export type KeyValidationResult =
  | { outcome: "valid" }
  /** `model` is set only for permission failures on a named model. */
  | { outcome: "unusable"; status: UnusableKeyStatus; code: OpenAIKeyErrorCode; model?: string }
  | { outcome: "rate_limited"; retryAfterSeconds: number }
  /** Network failure, timeout, or an unexpected response; says nothing about the key. */
  | { outcome: "unavailable" };

export interface KeyValidatorOptions extends KeyValidationModels {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export type KeyValidator = (apiKey: string, safetyIdentifier: string) => Promise<KeyValidationResult>;

const VALID = { outcome: "valid" } as const;
const UNAVAILABLE = { outcome: "unavailable" } as const;

/**
 * Checks a candidate key in order: model access for every configured model, a 1-token embedding
 * (billed to the user; catches `insufficient_quota`), then a discarded transcription client secret
 * (free; checks Realtime access). Results carry status and model ids only, never the key or bodies.
 */
export function createKeyValidator(
  { models, embeddingModel, transcriptionModel, fetch: fetchFn = fetch, timeoutMs = DEFAULT_TIMEOUT_MS }: KeyValidatorOptions,
): KeyValidator {
  const distinct = [...new Set([...models, embeddingModel, transcriptionModel])];

  async function checkModel(apiKey: string, model: string): Promise<KeyValidationResult> {
    let res: Response;
    try {
      res = await fetchFn(`${MODELS_URL}${encodeURIComponent(model)}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return UNAVAILABLE;
    }
    if (res.ok) {
      await res.body?.cancel();
      return VALID;
    }
    const failure = classifyOpenAIFailure(res.status, await readErrorCode(res));
    switch (failure) {
      case "auth":
        return { outcome: "unusable", status: "invalid", code: "invalid_api_key" };
      case "permission":
        return { outcome: "unusable", status: "permission_denied", code: "permission_denied", model };
      case "quota":
        return { outcome: "unusable", status: "quota_exhausted", code: "insufficient_quota" };
      case "rate_limited":
        return { outcome: "rate_limited", retryAfterSeconds: retryAfterSeconds(res) };
      default:
        return res.status === 404 ? { outcome: "unusable", status: "permission_denied", code: "model_unavailable", model } : UNAVAILABLE;
    }
  }

  function fromError(err: unknown, model: string): KeyValidationResult {
    const failure = keyFailureOf(err);
    if (failure) {
      return failure.status === "permission_denied" ? { outcome: "unusable", ...failure, model } : { outcome: "unusable", ...failure };
    }
    if (err instanceof AIRateLimitedError) {
      return { outcome: "rate_limited", retryAfterSeconds: err.retryAfterSeconds };
    }
    if (err instanceof RealtimeUnavailableError && err.failure === "rate_limited" && err.retryAfterSeconds !== undefined) {
      return { outcome: "rate_limited", retryAfterSeconds: err.retryAfterSeconds };
    }
    return UNAVAILABLE;
  }

  return async (apiKey, safetyIdentifier) => {
    for (const model of distinct) {
      const result = await checkModel(apiKey, model);
      if (result.outcome !== "valid") {
        return result;
      }
    }

    try {
      await createOpenAIEmbeddingProvider({ apiKey, fetch: fetchFn, timeoutMs, log: () => {} })
        .embed({ model: embeddingModel, input: ["ok"] });
    } catch (err) {
      return fromError(err, embeddingModel);
    }

    try {
      await createRealtimeClient({ apiKey, fetch: fetchFn, timeoutMs })
        .createTranscriptionClientSecret({ model: transcriptionModel }, safetyIdentifier);
    } catch (err) {
      return fromError(err, transcriptionModel);
    }
    return VALID;
  };
}
