import {
  AI_USAGE_MAX_TOKENS_PER_EVENT,
  type AiUsageTokens,
  ESTIMATED_REALTIME_AUDIO_TOKENS_PER_SECOND,
  type VoiceUsageEventRequest,
} from "@stackprep/shared";
import type { AiUsageEntry } from "../_shared/ai-usage.ts";

export interface TimedVoiceEvent {
  event_type: "connected" | "disconnected";
  occurred_at: string;
}

/** A connected / disconnected event with its row identity, for linking usage to segments. */
export interface VoiceSegmentEvent extends TimedVoiceEvent {
  id: string;
  sequence: number;
}

export interface VoiceSegment<E extends TimedVoiceEvent = TimedVoiceEvent> {
  /** The `connected` event that opened the segment. */
  opened: E;
  /** The `disconnected`, or the next `connected`, that closed it; null while open. */
  closedBy: E | null;
  startedAt: number;
  /** Epoch ms; null while open. */
  endedAt: number | null;
}

/**
 * Pairs voice events into connected segments. A `connected` without a matching `disconnected`
 * runs until the next `connected`; only the last segment can still be open. Stray disconnects and
 * unparsable timestamps are ignored.
 */
export function voiceSegments<E extends TimedVoiceEvent>(events: E[]): VoiceSegment<E>[] {
  const segments: VoiceSegment<E>[] = [];
  let open: VoiceSegment<E> | null = null;
  for (const event of events) {
    const at = Date.parse(event.occurred_at);
    if (Number.isNaN(at)) {
      continue;
    }
    if (open) {
      open.closedBy = event;
      open.endedAt = Math.max(at, open.startedAt);
      open = null;
    }
    if (event.event_type === "connected") {
      open = { opened: event, closedBy: null, startedAt: at, endedAt: null };
      segments.push(open);
    }
  }
  return segments;
}

export function openVoiceSegment<E extends TimedVoiceEvent>(segments: VoiceSegment<E>[]): VoiceSegment<E> | null {
  const last = segments.at(-1);
  return last && last.endedAt === null ? last : null;
}

/** Relayed counts capped per field, with cached never above input. */
export function clampVoiceUsage(event: VoiceUsageEventRequest): AiUsageTokens {
  const cap = (value: number) => Math.min(value, AI_USAGE_MAX_TOKENS_PER_EVENT);
  const input = cap(event.input_tokens);
  const audioInput = cap(event.audio_input_tokens);
  return {
    input_tokens: input,
    cached_input_tokens: Math.min(cap(event.cached_input_tokens), input),
    output_tokens: cap(event.output_tokens),
    audio_input_tokens: audioInput,
    audio_cached_input_tokens: Math.min(cap(event.audio_cached_input_tokens), audioInput),
    audio_output_tokens: cap(event.audio_output_tokens),
  };
}

export interface VoiceEstimateScope {
  userId: string;
  workspaceId: string;
  interviewId: string;
  realtimeModel: string;
  transcriptionModel: string;
}

/**
 * Duration-estimate rows for one closed segment: the realtime model from estimated audio tokens,
 * and transcription by the minute with no token counts. Keyed by segment and model, so each
 * segment is estimated once however many times its close is processed.
 */
export function voiceDurationEstimates(
  scope: VoiceEstimateScope,
  segment: VoiceSegment<VoiceSegmentEvent>,
  endedAt: number,
): AiUsageEntry[] {
  const seconds = Math.round(Math.max(0, endedAt - segment.startedAt)) / 1000;
  const base = {
    userId: scope.userId,
    workspaceId: scope.workspaceId,
    interviewId: scope.interviewId,
    task: "voice" as const,
    source: "duration_estimate" as const,
    audioSeconds: seconds,
    voiceSegmentEventId: segment.opened.id,
  };
  return [
    {
      ...base,
      model: scope.realtimeModel,
      tokens: {
        audio_input_tokens: Math.round(seconds * ESTIMATED_REALTIME_AUDIO_TOKENS_PER_SECOND.input),
        audio_output_tokens: Math.round(seconds * ESTIMATED_REALTIME_AUDIO_TOKENS_PER_SECOND.output),
      },
      idempotencyKey: `duration_estimate:${segment.opened.id}:${scope.realtimeModel}`,
    },
    {
      ...base,
      model: scope.transcriptionModel,
      idempotencyKey: `duration_estimate:${segment.opened.id}:${scope.transcriptionModel}`,
    },
  ];
}
