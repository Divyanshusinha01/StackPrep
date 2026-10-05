import type { z } from "zod";

/** Token counts from the provider's response, for usage tracking. */
export interface AIUsage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
}

export interface StructuredRequest<T> {
  model: string;
  /** Trusted instructions. Never interpolate repository or user content here. */
  system: string;
  /** Task input; may contain untrusted content, which the system prompt must fence. */
  input: string;
  /** Snake_case name the provider attaches to the output schema. */
  schemaName: string;
  /** Must be a strict object with every field required. */
  schema: z.ZodType<T>;
  maxOutputTokens?: number;
}

export interface StructuredResult<T> {
  output: T;
  usage: AIUsage;
}

/** The only AI surface application code depends on, so providers and models can change. */
export interface AIProvider {
  generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>>;
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

  constructor(readonly reason: "refusal" | "incomplete" | "malformed" | "schema_mismatch") {
    super(`AI output was invalid (${reason})`);
  }
}
