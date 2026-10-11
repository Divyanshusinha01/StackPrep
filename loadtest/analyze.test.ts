import { assertEquals } from "jsr:@std/assert@^1";
import { analyzeRun, type K6Record, type RunInput } from "./analyze.ts";

const START = 1_000_000;
const iso = (t: number) => new Date(t).toISOString();

function input(records: K6Record[], overrides: Partial<RunInput> = {}): RunInput {
  return {
    count: 1,
    startAt: START,
    warmupMs: 1_000,
    holdMs: 10_000,
    streamLifetimeMs: 140_000,
    interviewIds: ["i-1"],
    scheduledWritesPerInterview: 0,
    containerCpus: {},
    records,
    db: {
      clockOffsetMs: 0,
      statuses: [{ interview_id: "i-1", sequence: 2, event_type: "start", created_at: iso(START) }],
      turns: [
        { interview_id: "i-1", sequence: 1, role: "ai", client_event_id: "a", created_at: iso(START + 2_000) },
        { interview_id: "i-1", sequence: 2, role: "user", client_event_id: "b", created_at: iso(START + 5_000) },
        { interview_id: "i-1", sequence: 3, role: "ai", client_event_id: "c", created_at: iso(START + 8_000) },
      ],
      reports: [],
    },
    samples: [],
    statements: [],
    edgeErrorLines: 0,
    edgeWorkerLimitLines: 0,
    thresholds: { p95FrameDelayMs: 3_000, errorRate: 0.01, cpuSaturationShare: 0.9 },
    ...overrides,
  };
}

const turn = (conn: number, t: number, seq: number): K6Record => ({
  k: "frame",
  iv: 0,
  conn,
  t,
  ev: "turn_persisted",
  id: `2.${seq}.0`,
  data: { turn_sequence: seq, role: "ai", client_event_id: "x" },
});

Deno.test("dedupes replays, counts drops, and splits connected from reconnect-gap delay", () => {
  const m = analyzeRun(input([
    { k: "conn", iv: 0, conn: 0, requestedAt: START, openedAt: START + 10, closedAt: START + 4_000, status: 200, frames: 2, done: false, error: null },
    { k: "frame", iv: 0, conn: 0, t: START + 100, ev: "interview_status", id: "2.0.0", data: { status: "in_progress", event_sequence: 2 } },
    turn(0, START + 2_500, 1),
    { k: "conn", iv: 0, conn: 1, requestedAt: START + 6_000, openedAt: START + 6_050, closedAt: START + 9_000, status: 200, frames: 2, done: false, error: null },
    turn(1, START + 6_100, 2),
    turn(1, START + 6_100, 1),
  ]));
  assertEquals(m.frames.expected, 4);
  assertEquals(m.frames.receivedUnique, 3);
  assertEquals(m.frames.duplicates, 1);
  assertEquals(m.frames.dropped, 1);
  assertEquals(m.connectedFrameDelayMs.count, 1);
  assertEquals(m.connectedFrameDelayMs.p50, 500);
  assertEquals(m.reconnectGapFrameDelayMs.count, 1);
  assertEquals(m.reconnectGapFrameDelayMs.p50, 1_100);
  assertEquals(m.timeToFirstFrameMs.p50, 100);
  // Turns 1-3 fall in the window; turn 3 never arrived.
  assertEquals(m.frames.inWindowRows, 3);
  assertEquals(m.frames.undeliveredInWindow, 1);
  // Both connections closed early without report_ready.
  assertEquals(m.connections.premature, 2);
});

Deno.test("the clock offset moves database timestamps onto the host clock", () => {
  const m = analyzeRun(input([
    { k: "conn", iv: 0, conn: 0, requestedAt: START, openedAt: START, closedAt: START + 20_000, status: 200, frames: 1, done: false, error: null },
    turn(0, START + 2_300, 1),
  ], { db: { ...input([]).db, clockOffsetMs: 200 } }));
  assertEquals(m.connectedFrameDelayMs.p50, 500);
});
