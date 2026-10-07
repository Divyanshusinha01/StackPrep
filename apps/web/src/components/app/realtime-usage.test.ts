import { voiceUsageEventSchema } from "@stackprep/shared";
import { describe, expect, it } from "vitest";
import { EMPTY_TRANSCRIPT, transcriptReducer } from "./realtime-transcript";
import { newVoiceUsage, voiceUsageFromResponseDone } from "./realtime-usage";

const fullUsage = {
  total_tokens: 200,
  input_tokens: 120,
  output_tokens: 80,
  input_token_details: {
    text_tokens: 20,
    audio_tokens: 100,
    cached_tokens: 40,
    cached_tokens_details: { text_tokens: 10, audio_tokens: 30 },
  },
  output_token_details: { text_tokens: 10, audio_tokens: 70 },
};

const done = (response: unknown) => ({ type: "response.done", response });

describe("voiceUsageFromResponseDone", () => {
  it("maps a full usage payload", () => {
    const usage = voiceUsageFromResponseDone(done({ id: "resp_1", status: "completed", usage: fullUsage }));
    expect(usage).toEqual({
      type: "voice_usage",
      response_id: "resp_1",
      input_tokens: 120,
      cached_input_tokens: 40,
      output_tokens: 80,
      audio_input_tokens: 100,
      audio_cached_input_tokens: 30,
      audio_output_tokens: 70,
    });
    const request = {
      ...usage,
      client_event_id: "00000000-0000-4000-8000-000000000001",
      occurred_at: "2026-10-07T12:00:00.000Z",
    };
    expect(voiceUsageEventSchema.safeParse(request).success).toBe(true);
  });

  it("returns null without usage or a response id", () => {
    expect(voiceUsageFromResponseDone(done({ id: "resp_1", status: "completed" }))).toBeNull();
    expect(voiceUsageFromResponseDone(done({ id: "resp_1", usage: null }))).toBeNull();
    expect(voiceUsageFromResponseDone(done({ usage: fullUsage }))).toBeNull();
    expect(voiceUsageFromResponseDone(done({ id: "", usage: fullUsage }))).toBeNull();
    expect(voiceUsageFromResponseDone(done({ id: "r".repeat(129), usage: fullUsage }))).toBeNull();
    expect(voiceUsageFromResponseDone(done(null))).toBeNull();
    expect(voiceUsageFromResponseDone({ type: "response.done" })).toBeNull();
  });

  it("ignores other event types", () => {
    expect(voiceUsageFromResponseDone({ type: "response.created", response: { id: "resp_1", usage: fullUsage } })).toBeNull();
  });

  it("fills missing or invalid counts with 0", () => {
    const usage = voiceUsageFromResponseDone(
      done({
        id: "resp_2",
        usage: {
          input_tokens: 12.7,
          output_tokens: -3,
          input_token_details: { audio_tokens: "9", cached_tokens: Number.NaN },
          output_token_details: null,
        },
      }),
    );
    expect(usage).toEqual({
      type: "voice_usage",
      response_id: "resp_2",
      input_tokens: 12,
      cached_input_tokens: 0,
      output_tokens: 0,
      audio_input_tokens: 0,
      audio_cached_input_tokens: 0,
      audio_output_tokens: 0,
    });
  });

  it("leaves the transcript unchanged for a completed response.done", () => {
    const state = transcriptReducer(EMPTY_TRANSCRIPT, {
      type: "response.output_audio_transcript.done",
      item_id: "a1",
      transcript: "Hi.",
    });
    expect(transcriptReducer(state, done({ id: "resp_1", status: "completed" }))).toBe(state);
    expect(transcriptReducer(state, done({ id: "resp_1", status: "completed", usage: fullUsage }))).toBe(state);
  });
});

describe("newVoiceUsage", () => {
  it("emits each response's usage once, even when response.done is replayed", () => {
    const seen = new Set<string>();
    const event = done({ id: "resp_1", usage: fullUsage });
    expect(newVoiceUsage(event, seen)).toMatchObject({ response_id: "resp_1" });
    expect(newVoiceUsage(event, seen)).toBeNull();
    expect(newVoiceUsage(done({ id: "resp_2", usage: fullUsage }), seen)).toMatchObject({ response_id: "resp_2" });
  });

  it("does not mark a response as seen when it has no usage", () => {
    const seen = new Set<string>();
    expect(newVoiceUsage(done({ id: "resp_1" }), seen)).toBeNull();
    expect(newVoiceUsage(done({ id: "resp_1", usage: fullUsage }), seen)).toMatchObject({ response_id: "resp_1" });
  });
});
