import { z } from "zod";

// Admin allowlist ------------------------------------------------------------------

const uuidSchema = z.uuid();

/**
 * Parses `ADMIN_USER_IDS`, a comma-separated list of Supabase Auth user ids. Fails closed: an
 * unset or empty value, or any entry that is not a UUID, yields no admins at all. Emails are never
 * accepted, so authorization always rests on the stable user id.
 */
export function parseAdminUserIds(raw: string | undefined): ReadonlySet<string> {
  const entries = (raw ?? "").split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  if (entries.length === 0 || !entries.every((entry) => uuidSchema.safeParse(entry).success)) {
    return new Set();
  }
  return new Set(entries.map((entry) => entry.toLowerCase()));
}

export function isAdminUserId(adminUserIds: ReadonlySet<string>, userId: string | null | undefined): boolean {
  return typeof userId === "string" && adminUserIds.has(userId.toLowerCase());
}

/** Never throws, so a malformed allowlist disables the dashboard instead of the app. */
export const adminEnvSchema = z.object({
  ADMIN_USER_IDS: z.string().optional().transform(parseAdminUserIds),
});

// GET /admin/metrics -----------------------------------------------------------------

/** The only windows the dashboard offers; the SQL functions accept 1 to 90 days. */
export const ADMIN_WINDOW_DAYS = [1, 7, 30, 90] as const;
export const DEFAULT_ADMIN_WINDOW_DAYS = 7;
/** Fixed row limit for the per-interview cost list; never taken from the request. */
export const ADMIN_INTERVIEW_COST_LIMIT = 50;

export const adminWindowDaysSchema = z.coerce
  .number()
  .int()
  .refine((days) => (ADMIN_WINDOW_DAYS as readonly number[]).includes(days), "Unsupported window");

/** Postgres numeric and bigint may arrive as strings. */
const amount = z.coerce.number();
const rate = z.number().nullable();
const channel = z.enum(["voice", "text"]);

export const adminInterviewCostSchema = z.object({
  interview_id: z.uuid(),
  interview_created_at: z.string(),
  cost_usd: amount,
  voice_cost_usd: amount,
  text_cost_usd: amount,
  calls: z.int(),
  unpriced_calls: z.int(),
  has_estimate: z.boolean(),
});

export const adminVoiceTextSplitSchema = z.object({
  channel,
  calls: z.int(),
  cost_usd: amount,
  estimated_cost_usd: amount,
  unpriced_calls: z.int(),
  input_tokens: amount,
  cached_input_tokens: amount,
  output_tokens: amount,
  audio_input_tokens: amount,
  audio_cached_input_tokens: amount,
  audio_output_tokens: amount,
  audio_seconds: amount,
});

export const adminCacheHitRateSchema = z.object({
  channel,
  calls: z.int(),
  input_tokens: amount,
  cached_input_tokens: amount,
  hit_rate: rate,
});

export const adminToolLatencySchema = z.object({
  tool: z.string(),
  calls: z.int(),
  error_calls: z.int(),
  p50_ms: rate,
  p95_ms: rate,
  vector_fills: z.int(),
  vector_p50_ms: rate,
  vector_p95_ms: rate,
  vector_fallbacks: z.int(),
  deadline_fallback_share: rate,
});

/** Ids and aggregates only: no transcripts, repository content, or emails. Unknown keys are stripped. */
export const adminMetricsResponseSchema = z.object({
  window_days: adminWindowDaysSchema,
  interview_cost: z.array(adminInterviewCostSchema),
  voice_text_split: z.array(adminVoiceTextSplitSchema),
  cache_hit_rate: z.array(adminCacheHitRateSchema),
  tool_latency: z.array(adminToolLatencySchema),
});

export type AdminEnv = z.infer<typeof adminEnvSchema>;
export type AdminWindowDays = (typeof ADMIN_WINDOW_DAYS)[number];
export type AdminInterviewCost = z.infer<typeof adminInterviewCostSchema>;
export type AdminVoiceTextSplit = z.infer<typeof adminVoiceTextSplitSchema>;
export type AdminCacheHitRate = z.infer<typeof adminCacheHitRateSchema>;
export type AdminToolLatency = z.infer<typeof adminToolLatencySchema>;
export type AdminMetricsResponse = z.infer<typeof adminMetricsResponseSchema>;
