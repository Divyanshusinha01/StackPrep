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

export interface WebSearchRequest {
  model: string;
  /** Trusted instructions. */
  system: string;
  /** Must contain only generic, non-private search terms: it is sent to a web search. */
  input: string;
  /** Upper bound on web searches the model may run for this request. */
  maxToolCalls: number;
  maxOutputTokens?: number;
  reasoningEffort?: ReasoningEffort;
  timeoutMs?: number;
}

/** A source the search tool cited. URL and title come from the tool's annotation, never from model text. */
export interface WebCitation {
  url: string;
  title: string;
  /** The answer text immediately before the citation, which describes the source. */
  excerpt: string;
}

export interface WebSearchResult {
  citations: WebCitation[];
  /** Web searches the tool actually ran (each is billed by the provider). */
  searchCalls: number;
  usage: AIUsage;
}

/** Web search through the model provider, kept separate so text-generation fakes need not implement it. */
export interface WebSearchProvider {
  searchWeb(request: WebSearchRequest): Promise<WebSearchResult>;
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

/** The request itself was rejected (bad schema, auth, quota); retrying will not help. Subclasses name key failures. */
export class AIRequestError extends AIError {
  override name = "AIRequestError";

  constructor(readonly status: number) {
    super(`AI provider rejected the request (${status})`);
  }
}

/** 401: the API key is invalid or revoked. */
export class AIAuthError extends AIRequestError {
  override name = "AIAuthError";

  constructor() {
    super(401);
  }
}

/** 403, or 404 `model_not_found`: the key cannot use the model or endpoint. */
export class AIPermissionError extends AIRequestError {
  override name = "AIPermissionError";

  constructor(status: number, readonly reason: "permission_denied" | "model_unavailable") {
    super(status);
  }
}

/** 429 `insufficient_quota`: the account has no remaining credit or hit its spend limit; retrying will not help. */
export class AIQuotaError extends AIRequestError {
  override name = "AIQuotaError";

  constructor() {
    super(429);
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
