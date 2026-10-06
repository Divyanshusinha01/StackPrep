import type { InterviewStreamEvent } from "@stackprep/shared";
import { describe, expect, it, vi } from "vitest";
import {
  createSseParser,
  type InterviewEventStreamOptions,
  type SseFrame,
  startInterviewEventStream,
  STREAM_MAX_FAILURES,
} from "./interview-event-stream";

const URL_BASE = "https://project.supabase.co/functions/v1/interviews/ffffffff-0000-4000-8000-000000000001/events";
const CLIENT_EVENT_ID = "bbbbbbbb-0000-4000-8000-000000000001";

function parse(chunks: string[]) {
  const frames: SseFrame[] = [];
  const retries: number[] = [];
  const parser = createSseParser((f) => frames.push(f), (ms) => retries.push(ms));
  chunks.forEach((chunk) => parser.push(chunk));
  return { frames, retries };
}

describe("createSseParser", () => {
  it("reassembles frames split across chunks at any point", () => {
    const text = 'retry: 3000\n\nid: 1.0.0\nevent: interview_status\ndata: {"a":1}\n\n: heartbeat\n\nid: 1.1.0\nevent: turn_persisted\ndata: {"b":2}\n\n';
    const whole = parse([text]);
    for (let split = 1; split < text.length; split++) {
      expect(parse([text.slice(0, split), text.slice(split)])).toEqual(whole);
    }
    expect(parse(text.split(""))).toEqual(whole);
    expect(whole.retries).toEqual([3000]);
    expect(whole.frames).toEqual([
      { id: "1.0.0", event: "interview_status", data: '{"a":1}' },
      { id: "1.1.0", event: "turn_persisted", data: '{"b":2}' },
    ]);
  });

  it("ignores comments and blocks without data, and handles CRLF split across chunks", () => {
    const { frames } = parse([": heartbeat\r", "\n\r", "\nid: 2.0.0\r\nevent: x\r", "\ndata: one\r\ndata: two\r\n\r", "\n"]);
    expect(frames).toEqual([{ id: "2.0.0", event: "x", data: "one\ntwo" }]);
  });

  it("does not dispatch an unterminated frame", () => {
    expect(parse(["id: 1.0.0\nevent: x\ndata: {}\n"]).frames).toEqual([]);
  });
});

function frame(id: string, event: string, data: unknown) {
  return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const status = (id: string, seq: number) =>
  frame(id, "interview_status", { status: "in_progress", event_sequence: seq, occurred_at: "2026-10-05T12:00:00.000Z" });
const turn = (id: string, seq: number) =>
  frame(id, "turn_persisted", { turn_sequence: seq, role: "user", client_event_id: CLIENT_EVENT_ID });
const report = (id: string) => frame(id, "report_ready", { generated_at: "2026-10-05T12:30:00.000Z" });

function sse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

type Script = () => Response | Promise<Response>;

function harness(script: Script[], options: Partial<InterviewEventStreamOptions> = {}) {
  const urls: string[] = [];
  const headers: Record<string, string>[] = [];
  const events: InterviewStreamEvent[] = [];
  const sleeps: number[] = [];
  const onFallback = vi.fn();
  let finished = false;
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(String(input));
    headers.push(init?.headers as Record<string, string>);
    const next = script.shift();
    if (!next) {
      finished = true;
      // Park until stopped, like an idle open stream.
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    }
    return next();
  });
  const stream = startInterviewEventStream({
    url: URL_BASE,
    getHeaders: () => Promise.resolve({ Authorization: "Bearer token" }),
    onEvent: (event) => events.push(event),
    onFallback,
    fetch: fetchImpl as unknown as typeof fetch,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    random: () => 1,
    ...options,
  });
  return { stream, urls, headers, events, sleeps, onFallback, fetchImpl, exhausted: () => finished };
}

async function until(condition: () => boolean) {
  for (let i = 0; i < 200 && !condition(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(condition()).toBe(true);
}

const cursorOf = (url: string) => new URL(url).searchParams.get("last_event_id");

describe("startInterviewEventStream", () => {
  it("sends auth, starts without a cursor, and reconnects from the last received id", async () => {
    const h = harness([
      () => sse(["retry: 1500\n\n", status("1.0.0", 1), turn("1.1.0", 1)]),
      () => sse([turn("1.2.0", 2)]),
    ]);
    await until(h.exhausted);
    h.stream.stop();

    expect(h.headers[0]).toMatchObject({ Authorization: "Bearer token", Accept: "text/event-stream" });
    expect(h.urls.map(cursorOf)).toEqual([null, "1.1.0", "1.2.0"]);
    expect(h.events.map((e) => e.event)).toEqual(["interview_status", "turn_persisted", "turn_persisted"]);
    expect(h.sleeps.slice(0, 2)).toEqual([1500, 1500]);
    expect(h.stream.cursor()).toBe("1.2.0");
    expect(h.onFallback).not.toHaveBeenCalled();
  });

  it("stops for good after report_ready", async () => {
    const h = harness([() => sse([status("1.0.0", 1), report("1.0.1"), turn("1.5.1", 5)])]);
    await until(() => h.events.some((e) => e.event === "report_ready"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    expect(h.events.map((e) => e.event)).toEqual(["interview_status", "report_ready"]);
    expect(h.stream.cursor()).toBe("1.0.1");
  });

  it("skips frames that break the contract but still advances the cursor", async () => {
    const h = harness([
      () => sse([frame("1.0.0", "interview_status", { status: "paused" }), "id: 1.1.0\nevent: turn_persisted\ndata: not json\n\n"]),
    ]);
    await until(h.exhausted);
    h.stream.stop();
    expect(h.events).toEqual([]);
    expect(cursorOf(h.urls[1])).toBe("1.1.0");
  });

  it(`falls back to polling after ${STREAM_MAX_FAILURES} consecutive failed connects`, async () => {
    const h = harness([
      () => new Response(null, { status: 500 }),
      () => Promise.reject(new TypeError("network")),
      () => new Response(null, { status: 503 }),
      () => sse([]),
    ]);
    await until(() => h.onFallback.mock.calls.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.onFallback).toHaveBeenCalledTimes(1);
    expect(h.fetchImpl).toHaveBeenCalledTimes(STREAM_MAX_FAILURES);
    expect(h.sleeps).toEqual([3000, 6000]);
  });

  it("counts a missing session as a failure without calling fetch", async () => {
    const h = harness([], { getHeaders: () => Promise.resolve(null) });
    await until(() => h.onFallback.mock.calls.length > 0);
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it("resets the failure count after a successful connect", async () => {
    const fail = () => new Response(null, { status: 500 });
    const h = harness([fail, fail, () => sse([status("1.0.0", 1)]), fail, fail, () => sse([])]);
    await until(h.exhausted);
    h.stream.stop();
    expect(h.onFallback).not.toHaveBeenCalled();
    expect(h.fetchImpl).toHaveBeenCalledTimes(7);
  });

  it("drops a cursor the server refuses instead of retrying it forever", async () => {
    const h = harness([
      () => sse([status("1.0.0", 1)]),
      () => Response.json({ error: "The event cursor is invalid", code: "invalid_cursor" }, { status: 400 }),
      () => sse([]),
    ]);
    await until(h.exhausted);
    h.stream.stop();
    expect(h.urls.map(cursorOf)).toEqual([null, "1.0.0", null, null]);
  });

  it("stop() ends the loop", async () => {
    const h = harness([]);
    await until(h.exhausted);
    h.stream.stop();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    expect(h.onFallback).not.toHaveBeenCalled();
  });
});
