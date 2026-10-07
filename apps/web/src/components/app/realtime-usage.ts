import type { VoiceUsageEventRequest } from "@stackprep/shared";
import type { RealtimeServerEvent } from "./realtime-transcript";

/** Outbox input for one response's usage; the outbox adds `client_event_id` and `occurred_at`. */
export type VoiceUsageInput = Omit<VoiceUsageEventRequest, "client_event_id" | "occurred_at">;

const RESPONSE_ID_MAX_CHARS = 128;

function obj(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** Missing or invalid counts become 0, so a partial payload still yields a valid event. */
function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  const n = Math.floor(value);
  return Number.isSafeInteger(n) ? n : 0;
}

/** Usage reported by a Realtime `response.done`, or null when it has no response id or usage. */
export function voiceUsageFromResponseDone(event: RealtimeServerEvent): VoiceUsageInput | null {
  if (event.type !== "response.done") {
    return null;
  }
  const response = obj(event.response);
  const responseId = response.id;
  if (typeof responseId !== "string" || responseId.length === 0 || responseId.length > RESPONSE_ID_MAX_CHARS) {
    return null;
  }
  if (typeof response.usage !== "object" || response.usage === null) {
    return null;
  }
  const usage = obj(response.usage);
  const input = obj(usage.input_token_details);
  const cached = obj(input.cached_tokens_details);
  const output = obj(usage.output_token_details);
  return {
    type: "voice_usage",
    response_id: responseId,
    input_tokens: count(usage.input_tokens),
    cached_input_tokens: count(input.cached_tokens),
    output_tokens: count(usage.output_tokens),
    audio_input_tokens: count(input.audio_tokens),
    audio_cached_input_tokens: count(cached.audio_tokens),
    audio_output_tokens: count(output.audio_tokens),
  };
}

/**
 * Usage for a response not reported before. `seen` holds the response ids already emitted, so a
 * `response.done` replayed after a reconnect is not enqueued twice.
 */
export function newVoiceUsage(event: RealtimeServerEvent, seen: Set<string>): VoiceUsageInput | null {
  const usage = voiceUsageFromResponseDone(event);
  if (!usage || seen.has(usage.response_id)) {
    return null;
  }
  seen.add(usage.response_id);
  return usage;
}
