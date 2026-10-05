import { describe, expect, it } from "vitest";
import { relayToolCall } from "./realtime-tool-relay";
import { EMPTY_TRANSCRIPT, type RealtimeServerEvent, transcriptReducer } from "./realtime-transcript";

function run(events: RealtimeServerEvent[]) {
  return events.reduce(transcriptReducer, EMPTY_TRANSCRIPT);
}

describe("transcriptReducer", () => {
  it("streams interviewer deltas and finalizes with the full transcript", () => {
    const state = run([
      { type: "response.output_audio_transcript.delta", item_id: "a1", delta: "Walk me " },
      { type: "response.output_audio_transcript.delta", item_id: "a1", delta: "through it" },
    ]);
    expect(state.ai).toEqual([{ itemId: "a1", text: "Walk me through it", final: false, interrupted: false }]);
    const done = transcriptReducer(state, {
      type: "response.output_audio_transcript.done",
      item_id: "a1",
      transcript: "Walk me through it.",
    });
    expect(done.ai).toEqual([{ itemId: "a1", text: "Walk me through it.", final: true, interrupted: false }]);
  });

  it("streams and completes candidate transcription", () => {
    const state = run([
      { type: "conversation.item.input_audio_transcription.delta", item_id: "u1", delta: "It uses" },
      { type: "conversation.item.input_audio_transcription.completed", item_id: "u1", transcript: " It uses Postgres. " },
    ]);
    expect(state.user).toEqual([{ itemId: "u1", text: "It uses Postgres.", final: true, interrupted: false }]);
  });

  it("keeps candidate turns in speaking order even when transcription completes out of order", () => {
    const state = run([
      { type: "input_audio_buffer.speech_started", item_id: "u1" },
      { type: "input_audio_buffer.speech_started", item_id: "u2" },
      { type: "conversation.item.input_audio_transcription.completed", item_id: "u2", transcript: "second" },
      { type: "conversation.item.input_audio_transcription.completed", item_id: "u1", transcript: "first" },
    ]);
    expect(state.user.map((t) => t.text)).toEqual(["first", "second"]);
  });

  it("drops empty or failed candidate turns", () => {
    const state = run([
      { type: "input_audio_buffer.speech_started", item_id: "u1" },
      { type: "conversation.item.input_audio_transcription.completed", item_id: "u1", transcript: "  " },
      { type: "input_audio_buffer.speech_started", item_id: "u2" },
      { type: "conversation.item.input_audio_transcription.failed", item_id: "u2" },
    ]);
    expect(state.user).toEqual([]);
  });

  it("marks the interviewer turn as cut off on barge-in", () => {
    const base = run([
      { type: "response.output_audio_transcript.delta", item_id: "a1", delta: "Done." },
      { type: "response.output_audio_transcript.done", item_id: "a1", transcript: "Done." },
      { type: "response.output_audio_transcript.delta", item_id: "a2", delta: "Why did you" },
    ]);
    const cleared = transcriptReducer(base, { type: "output_audio_buffer.cleared" });
    expect(cleared.ai.map((t) => t.interrupted)).toEqual([false, true]);

    const cancelled = transcriptReducer(base, {
      type: "response.done",
      response: { status: "cancelled", output: [{ id: "a2", type: "message" }] },
    });
    expect(cancelled.ai[1]).toMatchObject({ itemId: "a2", final: true, interrupted: true });
    expect(cancelled.ai[0].interrupted).toBe(false);
  });

  it("ignores completed responses, unknown events, and malformed payloads", () => {
    const base = run([{ type: "response.output_audio_transcript.delta", item_id: "a1", delta: "Hi" }]);
    expect(transcriptReducer(base, { type: "response.done", response: { status: "completed", output: [] } })).toBe(base);
    expect(transcriptReducer(base, { type: "session.created" })).toBe(base);
    expect(transcriptReducer(base, { type: "response.output_audio_transcript.delta", delta: "x" })).toBe(base);
    expect(transcriptReducer(base, { type: "response.output_audio_transcript.delta", item_id: 4, delta: "x" })).toBe(base);
  });

  it("never renders function-call events", () => {
    const state = run([
      { type: "response.function_call_arguments.delta", item_id: "f1", delta: "{\"answerSummary\":" },
      { type: "response.function_call_arguments.done", item_id: "f1", call_id: "c1", arguments: "{}" },
    ]);
    expect(state).toEqual(EMPTY_TRANSCRIPT);
  });
});

describe("relayToolCall", () => {
  it("answers every tool call with unknown_tool and resumes the response", () => {
    const events = relayToolCall({
      type: "response.function_call_arguments.done",
      call_id: "call_1",
      name: "evaluate_answer",
      arguments: "{}",
    });
    expect(events).toEqual([
      {
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: "call_1",
          output: JSON.stringify({ ok: false, error: { code: "unknown_tool" } }),
        },
      },
      { type: "response.create" },
    ]);
  });

  it("ignores other events and calls without an id", () => {
    expect(relayToolCall({ type: "response.done" })).toEqual([]);
    expect(relayToolCall({ type: "response.function_call_arguments.done" })).toEqual([]);
  });
});
