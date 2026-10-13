import { describe, expect, it } from "vitest";
import {
  createTranscriptionLink,
  EMPTY_TRANSCRIPT,
  type RealtimeServerEvent,
  type TranscriptionLink,
  transcriptionFailed,
  transcriptReducer,
} from "./realtime-transcript";

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

describe("createTranscriptionLink", () => {
  function newLink() {
    let n = 0;
    return createTranscriptionLink(() => `evt_${++n}`);
  }

  /** Feeds voice events and transcription events through the link into the reducer. */
  function play(link: TranscriptionLink, voice: RealtimeServerEvent[], transcription: RealtimeServerEvent[]) {
    const events = [...voice, ...transcription.flatMap((e) => link.translate(e))];
    return run(events);
  }

  it("commits with a client event id per voice turn", () => {
    const link = newLink();
    expect(link.commit("v1")).toEqual({ type: "input_audio_buffer.commit", event_id: "evt_1" });
    expect(link.commit("v2")).toEqual({ type: "input_audio_buffer.commit", event_id: "evt_2" });
  });

  it("maps transcription items to voice items in commit order, even when transcripts complete out of order", () => {
    const link = newLink();
    link.commit("v1");
    link.commit("v2");
    const state = play(
      link,
      [
        { type: "input_audio_buffer.speech_started", item_id: "v1" },
        { type: "input_audio_buffer.speech_started", item_id: "v2" },
      ],
      [
        { type: "input_audio_buffer.committed", item_id: "t1" },
        { type: "input_audio_buffer.committed", item_id: "t2" },
        { type: "conversation.item.input_audio_transcription.delta", item_id: "t2", delta: "sec" },
        { type: "conversation.item.input_audio_transcription.completed", item_id: "t2", transcript: "second" },
        { type: "conversation.item.input_audio_transcription.completed", item_id: "t1", transcript: "first" },
      ],
    );
    expect(state.user).toEqual([
      { itemId: "v1", text: "first", final: true, interrupted: false },
      { itemId: "v2", text: "second", final: true, interrupted: false },
    ]);
  });

  it("ends the turn of a rejected commit so later turns stay aligned", () => {
    const link = newLink();
    link.commit("v1");
    link.commit("v2");
    const state = play(
      link,
      [
        { type: "input_audio_buffer.speech_started", item_id: "v1" },
        { type: "input_audio_buffer.speech_started", item_id: "v2" },
      ],
      [
        { type: "error", error: { code: "input_audio_buffer_commit_empty", event_id: "evt_1" } },
        { type: "input_audio_buffer.committed", item_id: "t1" },
        { type: "conversation.item.input_audio_transcription.completed", item_id: "t1", transcript: "second" },
      ],
    );
    expect(state.user).toEqual([{ itemId: "v2", text: "second", final: true, interrupted: false }]);
  });

  it("drops an empty or failed transcript and ignores unrelated or unknown events", () => {
    const link = newLink();
    link.commit("v1");
    link.commit("v2");
    expect(link.translate({ type: "error", error: { code: "other", event_id: "evt_9" } })).toEqual([]);
    expect(link.translate({ type: "session.created" })).toEqual([]);
    expect(link.translate({ type: "conversation.item.input_audio_transcription.completed", item_id: "tx", transcript: "x" }))
      .toEqual([]);
    const state = play(
      link,
      [
        { type: "input_audio_buffer.speech_started", item_id: "v1" },
        { type: "input_audio_buffer.speech_started", item_id: "v2" },
      ],
      [
        { type: "input_audio_buffer.committed", item_id: "t1" },
        { type: "input_audio_buffer.committed", item_id: "t2" },
        { type: "conversation.item.input_audio_transcription.completed", item_id: "t1", transcript: " " },
        { type: "conversation.item.input_audio_transcription.failed", item_id: "t2" },
      ],
    );
    expect(state.user).toEqual([]);
  });

  it("on reset, ends every waiting turn and keeps partial text", () => {
    const link = newLink();
    link.commit("v1");
    link.commit("v2");
    const before = play(
      link,
      [
        { type: "input_audio_buffer.speech_started", item_id: "v1" },
        { type: "input_audio_buffer.speech_started", item_id: "v2" },
      ],
      [
        { type: "input_audio_buffer.committed", item_id: "t1" },
        { type: "conversation.item.input_audio_transcription.delta", item_id: "t1", delta: "partial" },
      ],
    );
    const after = link.reset().reduce(transcriptReducer, before);
    expect(after.user).toEqual([{ itemId: "v1", text: "partial", final: true, interrupted: false }]);
    // Nothing from the old session maps after a reset.
    expect(link.translate({ type: "conversation.item.input_audio_transcription.completed", item_id: "t1", transcript: "late" }))
      .toEqual([]);
    expect(link.reset()).toEqual([]);
  });

  it("a turn with no transcription session is dropped", () => {
    const state = run([{ type: "input_audio_buffer.speech_started", item_id: "v1" }, transcriptionFailed("v1")]);
    expect(state.user).toEqual([]);
  });
});