import type { InterviewEventRequest } from "@stackprep/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_TRANSCRIPT, transcriptReducer } from "./realtime-transcript";
import {
  createTranscriptOutbox,
  drainTurns,
  newlyFinalTurns,
  type OutboxOptions,
  type OutboxStorage,
  type SendResult,
} from "./transcript-outbox";

const KEY = "stackprep:interview-outbox:test";

function memoryStorage(initial?: unknown): OutboxStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  if (initial !== undefined) {
    data.set(KEY, JSON.stringify(initial));
  }
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

function ids() {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
}

function ack(item: InterviewEventRequest, status: "created" | "duplicate" = "created", sequence = 1): SendResult {
  return item.type === "transcript_turn"
    ? { ok: true, ack: { type: item.type, status, client_event_id: item.client_event_id, turn_sequence: sequence } }
    : { ok: true, ack: { type: item.type, status, client_event_id: item.client_event_id, event_sequence: sequence } };
}

const turn = (content: string, itemId = content) =>
  ({ type: "transcript_turn", role: "user", content, item_id: itemId }) as const;

/** Each send resolves with the next scripted result, or an ack once the script runs out. */
function scripted(results: ((item: InterviewEventRequest) => SendResult | Promise<SendResult>)[] = []) {
  const sent: InterviewEventRequest[] = [];
  const send = vi.fn(async (item: InterviewEventRequest) => {
    sent.push(item);
    const next = results.shift();
    return next ? next(item) : ack(item);
  });
  return { send, sent };
}

function make(options: Partial<OutboxOptions> & Pick<OutboxOptions, "send">) {
  return createTranscriptOutbox({
    storageKey: KEY,
    randomId: ids(),
    now: () => new Date("2026-10-05T12:00:00.000Z"),
    random: () => 0,
    baseDelayMs: 100,
    maxDelayMs: 1_000,
    ...options,
  });
}

const tick = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("transcript outbox", () => {
  it("sends items in order, one at a time, without a client sequence", async () => {
    let release: (() => void) | null = null;
    const { send, sent } = scripted([
      (item) => new Promise((resolve) => (release = () => resolve(ack(item)))),
    ]);
    const storage = memoryStorage();
    const outbox = make({ send, storage });

    const first = outbox.enqueue(turn("one"));
    outbox.enqueue({ type: "connected" });
    outbox.enqueue(turn("two"));
    await tick();
    expect(sent).toHaveLength(1);

    release!();
    await tick();
    expect(sent.map((i) => (i.type === "transcript_turn" ? i.content : i.type))).toEqual(["one", "connected", "two"]);
    expect(sent.every((i) => !("sequence" in i))).toBe(true);
    expect(first).toMatchObject({ client_event_id: "00000000-0000-4000-8000-000000000001", occurred_at: "2026-10-05T12:00:00.000Z" });
    expect(outbox.pending()).toEqual([]);
    expect(storage.data.has(KEY)).toBe(false);
  });

  it("retries network errors, 5xx and 429 with backoff until acknowledged, reusing the event id", async () => {
    const { send, sent } = scripted([
      () => Promise.reject(new TypeError("offline")),
      () => ({ ok: false, retryable: true, code: "internal_error" }),
      () => ({ ok: false, retryable: true, code: "rate_limited" }),
    ]);
    const outbox = make({ send });
    outbox.enqueue(turn("hello"));
    await tick();
    expect(sent).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(49);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(sent).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(200);
    expect(sent).toHaveLength(4);
    expect(new Set(sent.map((i) => i.client_event_id)).size).toBe(1);
    expect(outbox.pending()).toEqual([]);
  });

  it("caps the backoff and keeps retrying without an attempt limit", async () => {
    const failures = Array.from({ length: 12 }, () => (): SendResult => ({ ok: false, retryable: true, code: "internal_error" }));
    const { sent, send } = scripted(failures);
    const outbox = make({ send });
    outbox.enqueue(turn("hello"));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sent).toHaveLength(13);
    expect(outbox.pending()).toEqual([]);
  });

  it("sends pause with its reason and resume, and reports every ack", async () => {
    const onAck = vi.fn();
    const { send, sent } = scripted([(item) => ack(item, "created", 7)]);
    const outbox = make({ send, onAck });
    outbox.enqueue(turn("answer"));
    outbox.enqueue({ type: "disconnected" });
    outbox.enqueue({ type: "pause", reason: "camera" });
    const resume = outbox.enqueue({ type: "resume" });
    await tick();
    expect(sent.map((i) => i.type)).toEqual(["transcript_turn", "disconnected", "pause", "resume"]);
    expect(sent[2]).toMatchObject({ type: "pause", reason: "camera" });
    expect(resume).not.toHaveProperty("reason");
    expect(onAck).toHaveBeenCalledTimes(4);
    expect(onAck.mock.calls[0][1]).toMatchObject({ type: "transcript_turn", turn_sequence: 7 });
    expect(onAck.mock.calls[3][0]).toBe(resume);
  });

  it("does not report a dropped item as acked", async () => {
    const onAck = vi.fn();
    const { send } = scripted([() => ({ ok: false, retryable: false, code: "event_conflict" })]);
    const outbox = make({ send, onAck });
    outbox.enqueue(turn("one"));
    await tick();
    expect(onAck).not.toHaveBeenCalled();
  });

  it("confirm drops a queued item the stream reports as stored, but never the in-flight one", async () => {
    let release: (() => void) | null = null;
    const { send, sent } = scripted([
      (item) => new Promise((resolve) => (release = () => resolve(ack(item)))),
    ]);
    const storage = memoryStorage();
    const outbox = make({ send, storage });
    const first = outbox.enqueue(turn("one"));
    const second = outbox.enqueue(turn("two"));
    outbox.enqueue(turn("three"));
    await tick();

    expect(outbox.confirm(first.client_event_id)).toBe(false);
    expect(outbox.confirm(second.client_event_id)).toBe(true);
    expect(outbox.confirm("00000000-0000-4000-8000-0000000000ff")).toBe(false);
    expect(JSON.parse(storage.data.get(KEY)!).queue).toHaveLength(2);

    release!();
    await tick();
    expect(sent.map((i) => (i.type === "transcript_turn" ? i.content : i.type))).toEqual(["one", "three"]);
    expect(outbox.pending()).toEqual([]);
  });

  it("confirm skips a head item waiting out its backoff", async () => {
    const { send, sent } = scripted([() => ({ ok: false, retryable: true, code: "internal_error" })]);
    const outbox = make({ send, maxDelayMs: 60_000, baseDelayMs: 60_000 });
    const stuck = outbox.enqueue(turn("one"));
    outbox.enqueue(turn("two"));
    await tick();
    expect(sent).toHaveLength(1);

    expect(outbox.confirm(stuck.client_event_id)).toBe(true);
    await tick();
    expect(sent.map((i) => (i.type === "transcript_turn" ? i.content : i.type))).toEqual(["one", "two"]);
    expect(outbox.pending()).toEqual([]);
  });

  it("treats a duplicate ack as delivered", async () => {
    const { send } = scripted([(item) => ack(item, "duplicate")]);
    const outbox = make({ send });
    outbox.enqueue(turn("hello"));
    await tick();
    expect(outbox.pending()).toEqual([]);
  });

  it("drops non-retryable failures so they cannot block the queue", async () => {
    const onDrop = vi.fn();
    const { send, sent } = scripted([() => ({ ok: false, retryable: false, code: "event_conflict" })]);
    const outbox = make({ send, onDrop });
    const dropped = outbox.enqueue(turn("one"));
    outbox.enqueue(turn("two"));
    await tick();
    expect(onDrop).toHaveBeenCalledWith(dropped, "event_conflict");
    expect(sent).toHaveLength(2);
    expect(outbox.pending()).toEqual([]);
  });

  it("drops an ack that does not match the in-flight item as a contract error", async () => {
    const onDrop = vi.fn();
    const { send } = scripted([
      (item) => ({ ok: true, ack: { ...(ack(item) as { ack: object }).ack, client_event_id: "00000000-0000-4000-8000-0000000000ee" } }),
      (item) => ({ ok: true, ack: { type: "connected", status: "created", client_event_id: item.client_event_id, event_sequence: 1 } }),
      (item) => ({ ok: true, ack: { type: "transcript_turn", status: "created", client_event_id: item.client_event_id, event_sequence: 1 } }),
    ]);
    const outbox = make({ send, onDrop });
    outbox.enqueue(turn("one"));
    outbox.enqueue(turn("two"));
    outbox.enqueue(turn("three"));
    await tick();
    expect(onDrop.mock.calls.map(([, code]) => code)).toEqual(["contract_error", "contract_error", "contract_error"]);
    expect(outbox.pending()).toEqual([]);
  });

  it("persists unsent items and resumes them with the same event ids after a refresh", async () => {
    const storage = memoryStorage();
    const offline = make({ send: () => new Promise(() => {}), storage });
    offline.enqueue(turn("one"));
    offline.enqueue(turn("two"));
    offline.dispose();
    const stored = JSON.parse(storage.data.get(KEY)!);
    expect(stored.queue).toHaveLength(2);

    const { send, sent } = scripted();
    make({ send, storage, randomId: () => "00000000-0000-4000-8000-0000000000ff" });
    await tick();
    expect(sent.map((i) => i.client_event_id)).toEqual(stored.queue.map((i: InterviewEventRequest) => i.client_event_id));
    expect(storage.data.has(KEY)).toBe(false);
  });

  it("needs no local state to continue an interview the server already has turns for", async () => {
    // Cleared storage or a second device: the server just assigns the next sequence.
    const { send } = scripted([(item) => ack(item, "created", 57)]);
    const onDrop = vi.fn();
    const outbox = make({ send, storage: memoryStorage(), onDrop });
    outbox.enqueue(turn("resumed"));
    await tick();
    expect(onDrop).not.toHaveBeenCalled();
    expect(outbox.pending()).toEqual([]);
  });

  it("ignores corrupt persisted entries", async () => {
    const storage = memoryStorage({ queue: [{ type: "transcript_turn", content: 3 }, "junk"] });
    const { send, sent } = scripted();
    make({ send, storage });
    await tick();
    expect(sent).toHaveLength(0);
  });

  it("flush and wake signals retry immediately instead of waiting out the backoff", async () => {
    let wake: (() => void) | null = null;
    const { send, sent } = scripted([
      () => ({ ok: false, retryable: true, code: "network_error" }),
      () => ({ ok: false, retryable: true, code: "network_error" }),
      () => ({ ok: false, retryable: true, code: "network_error" }),
    ]);
    const outbox = make({ send, subscribeWake: (w) => ((wake = w), () => {}), baseDelayMs: 10_000, maxDelayMs: 10_000 });
    outbox.enqueue(turn("hello"));
    await tick();
    expect(sent).toHaveLength(1);

    wake!();
    await tick();
    expect(sent).toHaveLength(2);

    const flushed = outbox.flush();
    await tick();
    await flushed;
    expect(sent).toHaveLength(3);

    const done = outbox.flush();
    await tick();
    await done;
    expect(sent).toHaveLength(4);
    expect(outbox.pending()).toEqual([]);
  });

  it("caps turn content at the request limit", () => {
    const outbox = make({ send: () => new Promise(() => {}) });
    const item = outbox.enqueue(turn("x".repeat(9_000)));
    expect(item.type === "transcript_turn" && item.content.length).toBe(8_000);
  });
});

describe("drainTurns", () => {
  it("resolves at once when no turn is pending, even with voice events queued", async () => {
    const outbox = make({ send: () => new Promise(() => {}) });
    outbox.enqueue({ type: "disconnected" });
    await expect(drainTurns(outbox)).resolves.toBe(true);
  });

  it("waits until every saved answer is acknowledged before a reconnect", async () => {
    const { send, sent } = scripted([
      () => ({ ok: false, retryable: true, code: "network_error" }),
      () => ({ ok: false, retryable: true, code: "network_error" }),
    ]);
    const outbox = make({ send, baseDelayMs: 60_000, maxDelayMs: 60_000 });
    outbox.enqueue(turn("my answer"));
    let drained: boolean | null = null;
    void drainTurns(outbox, 5_000, 500).then((ok) => (drained = ok));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(drained).toBe(true);
    expect(sent.length).toBeGreaterThanOrEqual(3);
    expect(outbox.pending()).toEqual([]);
  });

  it("gives up after the timeout so a reconnect is not blocked forever", async () => {
    const failures = Array.from({ length: 50 }, () => (): SendResult => ({ ok: false, retryable: true, code: "network_error" }));
    const { send } = scripted(failures);
    const outbox = make({ send, baseDelayMs: 60_000, maxDelayMs: 60_000 });
    outbox.enqueue(turn("my answer"));
    let drained: boolean | null = null;
    void drainTurns(outbox, 2_000, 500).then((ok) => (drained = ok));
    await vi.advanceTimersByTimeAsync(2_600);
    expect(drained).toBe(false);
    expect(outbox.pending()).toHaveLength(1);
  });
});

describe("newlyFinalTurns", () => {
  it("emits each final turn once, keyed by item id", () => {
    const seen = new Set<string>();
    let state = transcriptReducer(EMPTY_TRANSCRIPT, { type: "response.output_audio_transcript.delta", item_id: "a1", delta: "Hi" });
    expect(newlyFinalTurns(state, seen)).toEqual([]);

    state = transcriptReducer(state, { type: "response.output_audio_transcript.done", item_id: "a1", transcript: "Hi there." });
    expect(newlyFinalTurns(state, seen)).toEqual([
      { type: "transcript_turn", role: "ai", content: "Hi there.", item_id: "a1" },
    ]);
    expect(newlyFinalTurns(state, seen)).toEqual([]);

    state = transcriptReducer(state, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "u1",
      transcript: "Hello.",
    });
    expect(newlyFinalTurns(state, seen)).toEqual([
      { type: "transcript_turn", role: "user", content: "Hello.", item_id: "u1" },
    ]);
  });

  it("marks interrupted interviewer turns", () => {
    let state = transcriptReducer(EMPTY_TRANSCRIPT, { type: "response.output_audio_transcript.delta", item_id: "a1", delta: "So the" });
    state = transcriptReducer(state, { type: "output_audio_buffer.cleared" });
    expect(newlyFinalTurns(state, new Set())).toEqual([
      { type: "transcript_turn", role: "ai", content: "So the", item_id: "a1", interrupted: true },
    ]);
  });
});
