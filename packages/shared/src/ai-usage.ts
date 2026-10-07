import { z } from "zod";

// AI usage tracking. Every AI call writes an `ai_usage` row; cost is derived from the price table
// below so rows can be recalculated when prices change.

/** `auxiliary` is reserved and has no callers; it mirrors a Postgres enum value that cannot be dropped. */
export const aiTaskSchema = z.enum([
  "voice",
  "auxiliary",
  "deep_analysis",
  "planning",
  "evaluation",
  "report",
  "vision",
  "embedding",
]);
export type AiTask = z.infer<typeof aiTaskSchema>;

/**
 * - `provider`: counts returned by the provider to the backend; authoritative.
 * - `client_reported`: counts relayed by the browser; provisional.
 * - `duration_estimate`: derived from connected voice time; an approximation, never actual spend.
 */
export const aiUsageSourceSchema = z.enum(["provider", "client_reported", "duration_estimate"]);
export type AiUsageSource = z.infer<typeof aiUsageSourceSchema>;

/**
 * Token counts for one call. Input counts include their cached portion, matching the provider's
 * `usage` (cached tokens are a subset of input tokens). Omitted fields are zero.
 */
export interface AiUsageTokens {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  audio_input_tokens?: number;
  audio_cached_input_tokens?: number;
  audio_output_tokens?: number;
}

/** USD per 1M tokens. Without a `cachedInput` rate, cached tokens are billed at `input`. */
export interface TokenPrice {
  input: number;
  cachedInput?: number;
  output: number;
}

export interface ModelPrice {
  text?: TokenPrice;
  audio?: TokenPrice;
}

export const AI_PRICES: Readonly<Record<string, ModelPrice>> = {
  "gpt-5.6-terra": { text: { input: 2.0, cachedInput: 0.2, output: 12.0 } },
  "gpt-5.6-luna": { text: { input: 0.2, cachedInput: 0.02, output: 1.2 } },
  "gpt-realtime-2.1-mini": {
    text: { input: 0.6, cachedInput: 0.06, output: 2.4 },
    audio: { input: 10.0, cachedInput: 0.3, output: 20.0 },
  },
  "gpt-4o-mini-transcribe": { audio: { input: 1.25, output: 5.0 } },
  /** Embeddings bill input tokens only. */
  "text-embedding-3-small": { text: { input: 0.02, output: 0 } },
};

/** Per-minute estimate for transcription, used when no token counts are available. */
export const TRANSCRIPTION_ESTIMATED_USD_PER_MINUTE: Readonly<Record<string, number>> = {
  "gpt-4o-mini-transcribe": 0.003,
};

/** Approximate realtime audio tokens per connected second, used only for `duration_estimate` rows. */
export const ESTIMATED_REALTIME_AUDIO_TOKENS_PER_SECOND = { input: 10, output: 10 } as const;

/** Upper bound for any single token field accepted from a client report. */
export const AI_USAGE_MAX_TOKENS_PER_EVENT = 1_000_000;

function bucketCost(price: TokenPrice | undefined, input: number, cachedInput: number, output: number): number | null {
  if (input === 0 && cachedInput === 0 && output === 0) {
    return 0;
  }
  if (!price) {
    return null;
  }
  const cached = Math.min(Math.max(0, cachedInput), Math.max(0, input));
  const billableInput = Math.max(0, input - cached);
  return (billableInput * price.input + cached * (price.cachedInput ?? price.input) + Math.max(0, output) * price.output) /
    1_000_000;
}

/**
 * Estimated USD cost of a call. Returns `null` for an unknown model, or when tokens are present for
 * a modality the model has no price for, so the row is still written without a guessed cost.
 */
export function estimateCostUsd(model: string, tokens: AiUsageTokens): number | null {
  const price = AI_PRICES[model];
  if (!price) {
    return null;
  }
  const text = bucketCost(price.text, tokens.input_tokens ?? 0, tokens.cached_input_tokens ?? 0, tokens.output_tokens ?? 0);
  const audio = bucketCost(
    price.audio,
    tokens.audio_input_tokens ?? 0,
    tokens.audio_cached_input_tokens ?? 0,
    tokens.audio_output_tokens ?? 0,
  );
  return text === null || audio === null ? null : text + audio;
}

/** Estimated transcription cost from audio duration. Returns `null` for a model without a per-minute rate. */
export function estimateTranscriptionCostUsd(model: string, seconds: number): number | null {
  const rate = TRANSCRIPTION_ESTIMATED_USD_PER_MINUTE[model];
  if (rate === undefined) {
    return null;
  }
  return (Math.max(0, seconds) / 60) * rate;
}
