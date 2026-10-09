import type { z } from "zod";

/** Token counts from the provider's response, for usage tracking. */
export interface AIUsage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  /** Hidden reasoning tokens, already included in `output_tokens`; only for latency logging. */
  reasoning_tokens?: number;
}

/** "default" omits the parameter, for models that do not accept it. */
export type ReasoningEffort = "default" | "none" | "minimal" | "low" | "medium" | "high";
export type Verbosity = "low" | "medium" | "high";

export interface StructuredRequest<T> {
  model: string;
  /** Trusted instructions. Never interpolate repository or user content here. */
  system: string;
  /** Task input; may contain untrusted content, which the system prompt must fence. */
  input: string;
  /** Image data URLs sent at low detail after `input`. Never logged or stored by the provider. */
  images?: string[];
  /** Snake_case name the provider attaches to the output schema. */
  schemaName: string;
  /** Must be a strict object with every field required. */
  schema: z.ZodType<T>;
  /** Includes reasoning tokens; a response that hits it is invalid output (`incomplete`). */
  maxOutputTokens?: number;
  reasoningEffort?: ReasoningEffort;
  verbosity?: Verbosity;
  /** Per attempt; defaults to the provider's timeout. */
  timeoutMs?: number;
  /** Extra attempts after an AIUnavailableError (network, timeout, 5xx). Defaults to 0. */
  retries?: number;
}

export interface StructuredResult<T> {
  output: T;
  usage: AIUsage;
}

/** The only AI surface application code depends on, so providers and models can change. */
export interface AIProvider {
  generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>>;
}

export interface EmbeddingRequest {
  model: string;
  input: string[];
  /** Aborts the call; an abort surfaces as AIUnavailableError. */
  signal?: AbortSignal;
}

export interface EmbeddingResult {
  /** One vector per input, in input order. */
  embeddings: number[][];
  usage: { input_tokens: number };
}

/** Text embeddings, kept separate from AIProvider so text-generation fakes need not implement it. */
export interface EmbeddingProvider {
  embed(request: EmbeddingRequest): Promise<EmbeddingResult>;
}

export class AIError extends Error {
  override name = "AIError";
}

export class AIRateLimitedError extends AIError {
  override name = "AIRateLimitedError";

  constructor(readonly retryAfterSeconds: number) {
    super("AI provider rate limit exceeded");
  }
}

/** Network failure, timeout, or a 5xx; a retry may succeed. */
export class AIUnavailableError extends AIError {
  override name = "AIUnavailableError";

  constructor(readonly status?: number) {
    super("AI provider is unavailable");
  }
}

/** The request itself was rejected (bad schema, auth, quota); retrying will not help. */
export class AIRequestError extends AIError {
  override name = "AIRequestError";

  constructor(readonly status: number) {
    super(`AI provider rejected the request (${status})`);
  }
}

/** The model refused, stopped early, or produced output that does not match the schema. */
export class AIInvalidOutputError extends AIError {
  override name = "AIInvalidOutputError";

  constructor(readonly reason: "refusal" | "incomplete" | "malformed" | "schema_mismatch" | "dimension_mismatch") {
    super(`AI output was invalid (${reason})`);
  }
}

/**
 * Every vector must have exactly `dimensions` finite values. Vectors are never truncated or padded:
 * a model with a different native size is a configuration error.
 */
export function assertEmbeddingDimensions(embeddings: number[][], dimensions: number): void {
  for (const vector of embeddings) {
    if (vector.length !== dimensions || !vector.every((value) => typeof value === "number" && Number.isFinite(value))) {
      throw new AIInvalidOutputError("dimension_mismatch");
    }
  }
}
