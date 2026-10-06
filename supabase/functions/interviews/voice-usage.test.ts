import { assertAlmostEquals, assertEquals } from "@std/assert";
import { aiUsageCost } from "../_shared/ai-usage.ts";
import {
  clampVoiceUsage,
  openVoiceSegment,
  voiceDurationEstimates,
  type VoiceSegmentEvent,
  voiceSegments,
} from "./voice-usage.ts";

const T0 = Date.parse("2026-10-05T12:00:00.000Z");

function ev(sequence: number, event_type: VoiceSegmentEvent["event_type"], offsetSeconds: number): VoiceSegmentEvent {
  return { id: `e${sequence}`, sequence, event_type, occurred_at: new Date(T0 + offsetSeconds * 1000).toISOString() };
}

Deno.test("voiceSegments pairs connects with the disconnect or next connect that closes them", () => {
  const segments = voiceSegments([
    ev(1, "disconnected", 0),
    ev(2, "connected", 10),
    ev(3, "connected", 70),
    ev(4, "disconnected", 100),
    ev(5, "connected", 200),
  ]);
  assertEquals(segments.map((s) => [s.opened.id, s.closedBy?.id ?? null, s.endedAt === null ? null : (s.endedAt - s.startedAt) / 1000]), [
    ["e2", "e3", 60],
    ["e3", "e4", 30],
    ["e5", null, null],
  ]);
  assertEquals(openVoiceSegment(segments)?.opened.id, "e5");
  assertEquals(openVoiceSegment(segments.slice(0, 2)), null);
  assertEquals(openVoiceSegment([]), null);
});

Deno.test("voiceSegments skips unparsable timestamps", () => {
  const segments = voiceSegments([ev(1, "connected", 0), { ...ev(2, "disconnected", 5), occurred_at: "nope" }]);
  assertEquals(segments.length, 1);
  assertEquals(segments[0].endedAt, null);
});

Deno.test("clampVoiceUsage caps each field and keeps cached within input", () => {
  assertEquals(
    clampVoiceUsage({
      type: "voice_usage",
      client_event_id: "00000000-0000-4000-8000-000000000001",
      response_id: "resp_1",
      input_tokens: 10,
      cached_input_tokens: 50,
      output_tokens: 5_000_000,
      audio_input_tokens: 300,
      audio_cached_input_tokens: 200,
      audio_output_tokens: 7,
      occurred_at: "2026-10-05T12:00:00.000Z",
    }),
    {
      input_tokens: 10,
      cached_input_tokens: 10,
      output_tokens: 1_000_000,
      audio_input_tokens: 300,
      audio_cached_input_tokens: 200,
      audio_output_tokens: 7,
    },
  );
});

Deno.test("voiceDurationEstimates prices the realtime model by tokens and transcription by the minute", () => {
  const [segment] = voiceSegments([ev(1, "connected", 0), ev(2, "disconnected", 600)]);
  const [realtime, transcription] = voiceDurationEstimates(
    {
      userId: "u",
      workspaceId: "w",
      interviewId: "i",
      realtimeModel: "gpt-realtime-2.1-mini",
      transcriptionModel: "gpt-4o-mini-transcribe",
    },
    segment,
    segment.endedAt!,
  );
  assertEquals(realtime.idempotencyKey, "duration_estimate:e1:gpt-realtime-2.1-mini");
  assertEquals(realtime.tokens, { audio_input_tokens: 6_000, audio_output_tokens: 6_000 });
  // 6000 * 10.00 + 6000 * 20.00 per 1M tokens
  assertAlmostEquals(aiUsageCost(realtime)!, 0.18, 1e-12);
  assertEquals([transcription.tokens, transcription.audioSeconds], [undefined, 600]);
  assertAlmostEquals(aiUsageCost(transcription)!, 0.03, 1e-12);
});
