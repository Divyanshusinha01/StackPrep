import { assert, assertEquals } from "@std/assert";
import { apiErrorSchema, interviewStreamEventSchema, parseInterviewStreamCursor } from "@stackprep/shared";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import type { Authenticate } from "../_shared/auth.ts";
import { createRealtimeClient } from "../_shared/realtime/openai-realtime.ts";
import { createFakeAIProvider } from "../_shared/testing.ts";
import {
  type InterviewStreamReader,
  type PersistedTurnRow,
  pollStreamEvents,
  type StatusEventRow,
  type StreamTiming,
} from "./events.ts";
import { createInterviewsHandler, type InterviewRow, type InterviewStore } from "./handler.ts";
import { createFakeGithub, createFakeJobQueue, createFakeReportJobs, createFakeToolStore } from "./testing.ts";

const userId = "aaaaaaaa-0000-4000-8000-000000000001";
const webOrigin = "http://localhost:3000";
const INTERVIEW_ID = "ffffffff-0000-4000-8000-000000000001";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const T0 = Date.parse("2026-10-05T12:00:00.000Z");

const interviewRow: InterviewRow = {
  id: INTERVIEW_ID,
  workspace_id: "cccccccc-0000-4000-8000-000000000001",
  status: "in_progress",
  repository_commit_sha: SHA,
};

function at(seconds: number): string {
  return new Date(T0 + seconds * 1000).toISOString();
}

function clientEventId(n: number): string {
  return `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/** Any interview_events row; the stream must pick out start, completion, and termination itself. */
interface EventRow {
  sequence: number;
  event_type: string;
  occurred_at: string;
  created_at: string;
}

interface Data {
  events: EventRow[];
  turns: (Omit<PersistedTurnRow, "role"> & { role: "ai" | "user" | "system" })[];
  reportAt: string | null;
}

function sampleData(): Data {
  return {
    events: [
      { sequence: 1, event_type: "start", occurred_at: at(0), created_at: at(0) },
      { sequence: 2, event_type: "connected", occurred_at: at(1), created_at: at(1) },
      { sequence: 3, event_type: "tool_call", occurred_at: at(12), created_at: at(12) },
      { sequence: 4, event_type: "pause", occurred_at: at(20), created_at: at(20) },
      { sequence: 5, event_type: "completion", occurred_at: at(40), created_at: at(40) },
    ],
    turns: [
      { sequence: 1, role: "ai", client_event_id: clientEventId(1), item_id: "item_1", created_at: at(5) },
      { sequence: 2, role: "user", client_event_id: clientEventId(2), item_id: "item_2", created_at: at(10) },
      { sequence: 3, role: "system", client_event_id: clientEventId(3), item_id: null, created_at: at(11) },
      { sequence: 4, role: "ai", client_event_id: clientEventId(4), item_id: null, created_at: at(30) },
    ],
    reportAt: at(90),
  };
}

const STATUS_TYPES = ["start", "completion", "termination"];

/** Mirrors the RLS queries: event type, role, sequence, and limit filters. */
function createFakeStreamReader(data: Data, hooks: { onPoll?: (count: number) => void; fail?: boolean } = {}) {
  let polls = 0;
  const reader: InterviewStreamReader = {
    listStatusEvents(_id, after, limit) {
      hooks.onPoll?.(++polls);
      if (hooks.fail) {
        return Promise.reject(new Error("db down"));
      }
      return Promise.resolve(
        data.events
          .filter((e) => STATUS_TYPES.includes(e.event_type) && e.sequence > after)
          .slice(0, limit) as StatusEventRow[],
      );
    },
    listPersistedTurns(_id, after, limit) {
      return Promise.resolve(
        data.turns.filter((t) => t.role !== "system" && t.sequence > after).slice(0, limit) as PersistedTurnRow[],
      );
    },
    getReportGeneratedAt: () => Promise.resolve(data.reportAt),
  };
  return reader;
}

const FAST: StreamTiming = { pollMs: 5, heartbeatMs: 1_000, lifetimeMs: 80, retryMs: 2_500 };

function setup({
  data = sampleData(),
  interview = interviewRow as InterviewRow | null,
  timing = FAST,
  hooks = {},
}: { data?: Data; interview?: InterviewRow | null; timing?: StreamTiming; hooks?: Parameters<typeof createFakeStreamReader>[1] } = {}) {
  const rlsClient = { rls: true } as unknown as SupabaseClient;
  const authenticate: Authenticate = (req) =>
    Promise.resolve(
      req.headers.get("Authorization") === "Bearer valid" ? { user: { id: userId } as User, supabase: rlsClient } : null,
    );
  const unused = () => Promise.reject(new Error("unused"));
  const store: InterviewStore = {
    ...createFakeToolStore(),
    getPlan: unused,
    listVoiceEvents: unused,
    listVoiceSegmentEvents: unused,
    getRepositoryContext: unused,
    recordTranscriptTurn: unused,
    recordVoiceEvent: unused,
    reserveIntegrityCheck: unused,
    recordIntegritySignal: unused,
    pauseInterview: unused,
    resumeInterview: unused,
    endInterview: unused,
    deleteInterview: unused,
  };
  const handler = createInterviewsHandler({
    webOrigin,
    authenticate,
    reader: (client) => {
      assert(client === rlsClient, "reads must use the caller's RLS client");
      return {
        getInterview: (id) => Promise.resolve(interview && interview.id === id ? interview : null),
        getPlanningState: () => Promise.resolve("succeeded"),
        getReport: () => Promise.resolve(null),
        getReportJob: () => Promise.resolve(null),
      };
    },
    streamReader: (client) => {
      assert(client === rlsClient, "stream reads must use the caller's RLS client");
      return createFakeStreamReader(data, hooks);
    },
    streamTiming: timing,
    store,
    realtime: createRealtimeClient({ apiKey: "sk-test", fetch: unused }),
    model: "gpt-realtime-2.1-mini",
    transcriptionModel: "gpt-4o-mini-transcribe",
    github: createFakeGithub({}),
    ai: createFakeAIProvider(() => ({})),
    evaluationModel: "gpt-eval",
    visionModel: "gpt-vision",
    jobs: createFakeJobQueue(),
    reportJobs: createFakeReportJobs(),
  });
  return { handler, data };
}

function streamRequest(
  { auth = "Bearer valid", lastEventId, query, id = INTERVIEW_ID, signal }: {
    auth?: string;
    lastEventId?: string;
    query?: string;
    id?: string;
    signal?: AbortSignal;
  } = {},
) {
  const headers: Record<string, string> = { Authorization: auth, Origin: webOrigin };
  if (lastEventId !== undefined) {
    headers["Last-Event-ID"] = lastEventId;
  }
  const search = query === undefined ? "" : `?last_event_id=${encodeURIComponent(query)}`;
  return new Request(`http://localhost:54321/functions/v1/interviews/${id}/events${search}`, { headers, signal });
}

interface Block {
  id?: string;
  event?: string;
  data?: unknown;
  retry?: number;
  comment?: string;
}

function parseBlocks(text: string): Block[] {
  return text.split("\n\n").filter((raw) => raw !== "").map((raw) => {
    const block: Block = {};
    for (const line of raw.split("\n")) {
      if (line.startsWith(":")) {
        block.comment = line.slice(1).trim();
      } else if (line.startsWith("id: ")) {
        block.id = line.slice(4);
      } else if (line.startsWith("event: ")) {
        block.event = line.slice(7);
      } else if (line.startsWith("data: ")) {
        assert(block.data === undefined, "data must be a single line");
        block.data = JSON.parse(line.slice(6));
      } else if (line.startsWith("retry: ")) {
        block.retry = Number(line.slice(7));
      } else {
        throw new Error(`unexpected line: ${line}`);
      }
    }
    return block;
  });
}

const frames = (blocks: Block[]) => blocks.filter((b) => b.event !== undefined);

async function readAll(handler: (req: Request) => Promise<Response>, req: Request) {
  const res = await handler(req);
  assertEquals(res.status, 200);
  const started = Date.now();
  const text = await res.text();
  return { res, blocks: parseBlocks(text), elapsed: Date.now() - started };
}

async function expectError(res: Response, status: number, code: string) {
  assertEquals(res.status, status);
  assertEquals(apiErrorSchema.parse(await res.json()).code, code);
}

function silenceErrors<T>(run: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (line: string) => lines.push(line);
  return run().then((result) => ({ result, lines })).finally(() => {
    console.error = original;
  });
}

Deno.test("stream: auth and ownership are checked before streaming", async () => {
  const { handler } = setup();
  await expectError(await handler(streamRequest({ auth: "Bearer nope" })), 401, "unauthorized");
  await expectError(await handler(streamRequest({ id: "not-a-uuid" })), 404, "interview_not_found");
  await expectError(await setup({ interview: null }).handler(streamRequest()), 404, "interview_not_found");
});

Deno.test("stream: SSE headers and a retry hint first", async () => {
  const { handler } = setup();
  const { res, blocks } = await readAll(handler, streamRequest());
  assertEquals(res.headers.get("content-type"), "text/event-stream");
  assertEquals(res.headers.get("cache-control"), "no-store");
  assertEquals(res.headers.get("access-control-allow-origin"), webOrigin);
  assertEquals(blocks[0], { retry: FAST.retryMs });
});

Deno.test("stream: full replay emits only the three event types, in created_at order, with valid frames", async () => {
  const { handler } = setup();
  const { blocks } = await readAll(handler, streamRequest());
  const emitted = frames(blocks);
  for (const frame of emitted) {
    interviewStreamEventSchema.parse({ event: frame.event, data: frame.data });
    assert(parseInterviewStreamCursor(frame.id ?? ""), `invalid id ${frame.id}`);
  }
  assertEquals(emitted.map((f) => [f.event, f.id]), [
    ["interview_status", "1.0.0"],
    ["turn_persisted", "1.1.0"],
    ["turn_persisted", "1.2.0"],
    ["turn_persisted", "1.4.0"],
    ["interview_status", "5.4.0"],
    ["report_ready", "5.4.1"],
  ]);
  assertEquals(emitted[0].data, { status: "in_progress", event_sequence: 1, occurred_at: at(0) });
  assertEquals(emitted[1].data, { turn_sequence: 1, role: "ai", client_event_id: clientEventId(1), item_id: "item_1" });
  assertEquals(emitted[3].data, { turn_sequence: 4, role: "ai", client_event_id: clientEventId(4) });
  assertEquals(emitted[4].data, { status: "completed", event_sequence: 5, occurred_at: at(40) });
  assertEquals(emitted[5].data, { generated_at: at(90) });
});

Deno.test("stream: report_ready is terminal and closes the stream before its lifetime", async () => {
  const { handler } = setup({ timing: { ...FAST, lifetimeMs: 10_000 } });
  const { blocks, elapsed } = await readAll(handler, streamRequest());
  assertEquals(frames(blocks).at(-1)?.event, "report_ready");
  assert(elapsed < 5_000, `closed after ${elapsed} ms`);
});

Deno.test("stream: termination maps to the terminated status", async () => {
  const data = sampleData();
  data.events = [{ sequence: 1, event_type: "termination", occurred_at: at(3), created_at: at(3) }];
  data.reportAt = null;
  const { blocks } = await readAll(setup({ data }).handler, streamRequest());
  assertEquals(frames(blocks)[0].data, { status: "terminated", event_sequence: 1, occurred_at: at(3) });
});

Deno.test("stream: reconnecting with each emitted id replays exactly the strictly later events", async () => {
  const full = frames((await readAll(setup().handler, streamRequest())).blocks);
  for (let i = 0; i < full.length; i++) {
    const { blocks } = await readAll(setup().handler, streamRequest({ lastEventId: full[i].id }));
    assertEquals(
      frames(blocks).map((f) => [f.event, f.id, f.data]),
      full.slice(i + 1).map((f) => [f.event, f.id, f.data]),
      `after ${full[i].id}`,
    );
  }
});

Deno.test("stream: a cursor with the report flag set never re-emits report_ready", async () => {
  const { blocks } = await readAll(setup().handler, streamRequest({ lastEventId: "0.0.1" }));
  const emitted = frames(blocks);
  assert(emitted.length > 0);
  assert(!emitted.some((f) => f.event === "report_ready"));
  assert(emitted.every((f) => f.id?.endsWith(".1")));
});

Deno.test("stream: a cursor ahead of the stored data emits nothing", async () => {
  const { blocks } = await readAll(setup().handler, streamRequest({ lastEventId: "50.50.1" }));
  assertEquals(frames(blocks), []);
});

Deno.test("stream: a malformed cursor is rejected rather than replayed from zero", async () => {
  const { handler } = setup();
  for (const cursor of ["abc", "1.2", "1.2.3", "-1.0.0", "1.0.0.0"]) {
    await expectError(await handler(streamRequest({ lastEventId: cursor })), 400, "invalid_cursor");
    await expectError(await handler(streamRequest({ query: cursor })), 400, "invalid_cursor");
  }
});

Deno.test("stream: the query cursor is accepted, and the header wins over it", async () => {
  const viaQuery = frames((await readAll(setup().handler, streamRequest({ query: "5.4.0" }))).blocks);
  assertEquals(viaQuery.map((f) => f.event), ["report_ready"]);
  const both = frames((await readAll(setup().handler, streamRequest({ lastEventId: "5.4.1", query: "0.0.0" }))).blocks);
  assertEquals(both, []);
});

Deno.test("stream: rows appearing between polls are emitted once, with non-decreasing ids", async () => {
  const data = sampleData();
  data.events = data.events.slice(0, 2);
  data.turns = data.turns.slice(0, 1);
  data.reportAt = null;
  const { handler } = setup({
    data,
    timing: { ...FAST, lifetimeMs: 10_000 },
    hooks: {
      onPoll(count) {
        if (count === 3) {
          data.turns.push({ sequence: 2, role: "user", client_event_id: clientEventId(2), item_id: "item_2", created_at: at(10) });
        } else if (count === 5) {
          data.turns.push({ sequence: 3, role: "ai", client_event_id: clientEventId(3), item_id: null, created_at: at(30) });
          data.events.push({ sequence: 3, event_type: "completion", occurred_at: at(40), created_at: at(40) });
        } else if (count === 8) {
          data.reportAt = at(90);
        }
      },
    },
  });
  const emitted = frames((await readAll(handler, streamRequest())).blocks);
  assertEquals(emitted.map((f) => f.id), ["1.0.0", "1.1.0", "1.2.0", "1.3.0", "3.3.0", "3.3.1"]);
  const keys = emitted.map((f) => `${f.event}:${JSON.stringify(f.data)}`);
  assertEquals(new Set(keys).size, keys.length);
  for (let i = 1; i < emitted.length; i++) {
    const prev = parseInterviewStreamCursor(emitted[i - 1].id ?? "")!;
    const next = parseInterviewStreamCursor(emitted[i].id ?? "")!;
    assert(next.eventSequence >= prev.eventSequence && next.turnSequence >= prev.turnSequence);
    assert(Number(next.reportSent) >= Number(prev.reportSent));
  }
});

Deno.test("stream: heartbeats are comments without an id, and the stream ends at its lifetime", async () => {
  const { handler } = setup({ timing: { pollMs: 5, heartbeatMs: 15, lifetimeMs: 120, retryMs: 2_500 } });
  const { blocks, elapsed } = await readAll(handler, streamRequest({ lastEventId: "50.50.1" }));
  const heartbeats = blocks.filter((b) => b.comment === "heartbeat");
  assert(heartbeats.length >= 2, `got ${heartbeats.length} heartbeats`);
  assert(heartbeats.every((b) => b.id === undefined && b.event === undefined && b.data === undefined));
  assert(elapsed < 2_000, `closed after ${elapsed} ms`);
});

Deno.test("stream: a client abort stops the stream", async () => {
  const controller = new AbortController();
  let polls = 0;
  const { handler } = setup({
    timing: { ...FAST, lifetimeMs: 60_000 },
    hooks: { onPoll: () => polls++ },
  });
  const res = await handler(streamRequest({ lastEventId: "50.50.1", signal: controller.signal }));
  const reader = res.body!.getReader();
  await reader.read();
  controller.abort();
  while (!(await reader.read()).done) {
    // Drain until the server closes.
  }
  const after = polls;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assertEquals(polls, after);
});

Deno.test("stream: a read failure closes the stream and is logged", async () => {
  const { handler } = setup({ timing: { ...FAST, lifetimeMs: 60_000 }, hooks: { fail: true } });
  const { result, lines } = await silenceErrors(() => readAll(handler, streamRequest()));
  assertEquals(frames(result.blocks), []);
  assert(lines.some((line) => JSON.parse(line).event === "interview_stream_failed"));
});

Deno.test("poll: report_ready waits until both batches are drained", async () => {
  const data = sampleData();
  const reader = createFakeStreamReader(data);
  const first = await pollStreamEvents(reader, INTERVIEW_ID, { eventSequence: 0, turnSequence: 0, reportSent: false }, 2);
  assertEquals(first.done, false);
  assert(!first.frames.some((f) => f.event.event === "report_ready"));
  let cursor = first.cursor;
  const seen = first.frames.map((f) => f.id);
  for (let i = 0; i < 10; i++) {
    const next = await pollStreamEvents(reader, INTERVIEW_ID, cursor, 2);
    seen.push(...next.frames.map((f) => f.id));
    cursor = next.cursor;
    if (next.done) {
      break;
    }
  }
  assertEquals(cursor, { eventSequence: 5, turnSequence: 4, reportSent: true });
  assertEquals(new Set(seen).size, seen.length);
});
