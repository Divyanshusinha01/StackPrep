import {
  type AiTask,
  type AiUsageSource,
  type AiUsageTokens,
  estimateCostUsd,
  estimateTranscriptionCostUsd,
  TRANSCRIPTION_ESTIMATED_USD_PER_MINUTE,
} from "@stackprep/shared";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AIUsage } from "./ai/provider.ts";
import { reportUnexpected } from "./sentry.ts";

/** One `ai_usage` row before cost is computed. */
export interface AiUsageEntry {
  userId: string;
  workspaceId: string;
  /** Null for repository analysis. */
  interviewId: string | null;
  task: AiTask;
  model: string;
  source: AiUsageSource;
  tokens?: AiUsageTokens;
  audioSeconds?: number;
  /** The `connected` event that opened the voice segment; required for voice rows. */
  voiceSegmentEventId?: string;
  /** Globally unique; a repeated key is a no-op. */
  idempotencyKey: string;
  /** The credential whose key made the call; omitted rows take the owner's current credential. */
  openaiCredentialId?: string;
}

/** `failed` means the row was not written; the failure is already logged. */
export type AiUsageRecordStatus = "created" | "duplicate" | "failed";

/** Usage persistence. Never throws, so a tracking failure cannot break the user-facing flow. */
export interface AiUsageRecorder {
  recordAiUsage(entry: AiUsageEntry): Promise<AiUsageRecordStatus>;
}

export function providerTokens(usage: AIUsage): AiUsageTokens {
  return {
    input_tokens: usage.input_tokens,
    cached_input_tokens: usage.cached_input_tokens,
    output_tokens: usage.output_tokens,
  };
}

function hasTokens(tokens: AiUsageTokens | undefined): boolean {
  return Object.values(tokens ?? {}).some((value) => (value ?? 0) > 0);
}

/**
 * Token pricing, or the per-minute transcription rate for a duration-only row of a model that has
 * one. Null when the model has no applicable price.
 */
export function aiUsageCost(entry: Pick<AiUsageEntry, "model" | "tokens" | "audioSeconds">): number | null {
  if (!hasTokens(entry.tokens) && entry.audioSeconds !== undefined && entry.model in TRANSCRIPTION_ESTIMATED_USD_PER_MINUTE) {
    return estimateTranscriptionCostUsd(entry.model, entry.audioSeconds);
  }
  return estimateCostUsd(entry.model, entry.tokens ?? {});
}

export function aiUsageRow(entry: AiUsageEntry) {
  const tokens = entry.tokens ?? {};
  return {
    user_id: entry.userId,
    workspace_id: entry.workspaceId,
    interview_id: entry.interviewId,
    task: entry.task,
    model: entry.model,
    source: entry.source,
    input_tokens: tokens.input_tokens ?? 0,
    cached_input_tokens: tokens.cached_input_tokens ?? 0,
    output_tokens: tokens.output_tokens ?? 0,
    audio_input_tokens: tokens.audio_input_tokens ?? 0,
    audio_cached_input_tokens: tokens.audio_cached_input_tokens ?? 0,
    audio_output_tokens: tokens.audio_output_tokens ?? 0,
    audio_seconds: entry.audioSeconds ?? null,
    voice_segment_event_id: entry.voiceSegmentEventId ?? null,
    estimated_cost_usd: aiUsageCost(entry),
    idempotency_key: entry.idempotencyKey,
    openai_credential_id: entry.openaiCredentialId ?? null,
  };
}

/** Inserts one row with `on conflict (idempotency_key) do nothing`. Failures are logged, never thrown. */
export async function recordAiUsage(db: SupabaseClient, entry: AiUsageEntry): Promise<AiUsageRecordStatus> {
  try {
    const { data, error } = await db
      .from("ai_usage")
      .upsert(aiUsageRow(entry), { onConflict: "idempotency_key", ignoreDuplicates: true })
      .select("id");
    if (error) {
      throw new Error(error.message);
    }
    return data && data.length > 0 ? "created" : "duplicate";
  } catch (err) {
    console.error(JSON.stringify({
      event: "ai_usage_record_failed",
      task: entry.task,
      source: entry.source,
      model: entry.model,
      interview_id: entry.interviewId,
      reason: err instanceof Error ? err.message : "unknown",
    }));
    reportUnexpected(err, {
      event: "ai_usage_record_failed",
      code: "internal_error",
      workspace_id: entry.workspaceId,
      ...(entry.interviewId ? { interview_id: entry.interviewId } : {}),
    });
    return "failed";
  }
}

export function createAiUsageRecorder(db: SupabaseClient): AiUsageRecorder {
  return { recordAiUsage: (entry) => recordAiUsage(db, entry) };
}
