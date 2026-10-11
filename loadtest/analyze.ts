// Per-run metrics from the k6 event log, the database rows, and the resource samples. Pure: no
// I/O, so a run can be re-analyzed from its saved raw files (`deno run analyze.ts <run dir>`).
import { quantile } from "./lib.ts";

export interface FrameRecord {
  k: "frame";
  iv: number;
  conn: number;
  t: number;
  ev: string;
  id: string;
  data: Record<string, unknown> | null;
}

export interface ConnRecord {
  k: "conn";
  iv: number;
  conn: number;
  requestedAt: number;
  openedAt: number | null;
  closedAt: number;
  status: number;
  frames: number;
  done: boolean;
  error: string | null;
}

export interface WriteRecord {
  k: "write";
  iv: number;
  i?: number;
  kind: string;
  cei?: string;
  plannedAt: number;
  startedAt: number;
  endedAt: number;
  status: number;
}

export interface FallbackRecord {
  k: "fallback";
  iv: number;
  t: number;
}

export type K6Record = FrameRecord | ConnRecord | WriteRecord | FallbackRecord;

export interface DbRows {
  /** Host-clock correction: database clock minus host clock, in ms. */
  clockOffsetMs: number;
  statuses: { interview_id: string; sequence: number; event_type: string; created_at: string }[];
  turns: { interview_id: string; sequence: number; role: string; client_event_id: string; created_at: string }[];
  reports: { interview_id: string; generated_at: string }[];
}

export interface Sample {
  t: number;
  containers: Record<string, { cpuPct: number; memMiB: number }>;
  pg?: { active: number; total: number };
}

export interface StatementDelta {
  category: string;
  query: string;
  calls: number;
  totalMs: number;
}

export interface RunInput {
  count: number;
  startAt: number;
  warmupMs: number;
  holdMs: number;
  streamLifetimeMs: number;
  interviewIds: string[];
  scheduledWritesPerInterview: number;
  containerCpus: Record<string, number>;
  records: K6Record[];
  db: DbRows;
  samples: Sample[];
  statements: StatementDelta[];
  edgeErrorLines: number;
  /** Edge runtime log lines about a worker hitting a CPU, memory, or wall-clock limit. */
  edgeWorkerLimitLines: number;
  /** Set when `supabase functions serve` exited mid-run (for example the container was OOM-killed). */
  edgeRuntimeCrash?: string | null;
  thresholds: { p95FrameDelayMs: number; errorRate: number; cpuSaturationShare: number };
}

export interface Stats {
  count: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
}

function stats(values: number[]): Stats {
  const sorted = [...values].sort((a, b) => a - b);
  const r = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10);
  return {
    count: sorted.length,
    p50: r(quantile(sorted, 0.5)),
    p95: r(quantile(sorted, 0.95)),
    p99: r(quantile(sorted, 0.99)),
    max: r(sorted.length ? sorted[sorted.length - 1] : null),
  };
}

const STATUS_FOR: Record<string, string> = { start: "in_progress", completion: "completed", termination: "terminated" };

export function analyzeRun(input: RunInput) {
  const windowStart = input.startAt + input.warmupMs;
  const windowEnd = windowStart + input.holdMs;
  const ivByInterview = new Map(input.interviewIds.map((id, iv) => [id, iv]));
  const hostTime = (dbIso: string) => Date.parse(dbIso) - input.db.clockOffsetMs;

  // Every row the stream must deliver, keyed the way frames identify themselves.
  interface Expected {
    createdAt: number;
    kind: "status" | "turn" | "report";
    status?: string;
  }
  const expected = new Map<string, Expected>();
  for (const row of input.db.statuses) {
    const iv = ivByInterview.get(row.interview_id);
    if (iv !== undefined) {
      expected.set(`${iv}:s:${row.sequence}`, { createdAt: hostTime(row.created_at), kind: "status", status: STATUS_FOR[row.event_type] });
    }
  }
  for (const row of input.db.turns) {
    const iv = ivByInterview.get(row.interview_id);
    if (iv !== undefined) {
      expected.set(`${iv}:t:${row.sequence}`, { createdAt: hostTime(row.created_at), kind: "turn" });
    }
  }
  for (const row of input.db.reports) {
    const iv = ivByInterview.get(row.interview_id);
    if (iv !== undefined) {
      expected.set(`${iv}:r`, { createdAt: hostTime(row.generated_at), kind: "report" });
    }
  }

  const frames = input.records.filter((r): r is FrameRecord => r.k === "frame");
  const conns = input.records.filter((r): r is ConnRecord => r.k === "conn");
  const writes = input.records.filter((r): r is WriteRecord => r.k === "write");
  const fallbacks = input.records.filter((r): r is FallbackRecord => r.k === "fallback");

  // A row written while its interview had no open stream (the SSE lifetime reconnect, or a failed
  // connect) waits for the next connection; that delay is reported apart from the connected one.
  const openIntervals = new Map<number, [number, number][]>();
  for (const c of input.records) {
    if (c.k === "conn" && c.openedAt !== null) {
      const list = openIntervals.get(c.iv) ?? [];
      list.push([c.openedAt, c.closedAt]);
      openIntervals.set(c.iv, list);
    }
  }
  const connectedAt = (iv: number, t: number) => (openIntervals.get(iv) ?? []).some(([a, b]) => t >= a && t <= b);

  const seen = new Map<string, number>();
  let malformed = 0;
  let unexpected = 0;
  const windowDelays: number[] = [];
  const connectedDelays: number[] = [];
  const gapDelays: number[] = [];
  const completedDelays: number[] = [];
  const reportDelays: number[] = [];
  for (const f of frames) {
    let key: string | null = null;
    if (f.data === null) {
      malformed++;
      continue;
    }
    if (f.ev === "interview_status") {
      key = `${f.iv}:s:${f.data.event_sequence}`;
    } else if (f.ev === "turn_persisted") {
      key = `${f.iv}:t:${f.data.turn_sequence}`;
    } else if (f.ev === "report_ready") {
      key = `${f.iv}:r`;
    }
    const row = key ? expected.get(key) : undefined;
    if (!key || !row) {
      unexpected++;
      continue;
    }
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    if (count > 1) {
      continue;
    }
    const delay = f.t - row.createdAt;
    if (row.kind === "report") {
      reportDelays.push(delay);
    } else if (row.kind === "status" && row.status === "completed") {
      completedDelays.push(delay);
    } else if (row.createdAt >= windowStart && row.createdAt < windowEnd) {
      windowDelays.push(delay);
      (connectedAt(f.iv, row.createdAt) ? connectedDelays : gapDelays).push(delay);
    }
  }
  const duplicates = [...seen.values()].reduce((sum, n) => sum + n - 1, 0);
  // Delay percentiles only see delivered frames; rows that never arrived are counted here instead.
  const inWindowRows = [...expected.entries()].filter(([, row]) =>
    row.kind !== "report" && row.status !== "completed" && row.createdAt >= windowStart && row.createdAt < windowEnd
  );
  const undeliveredInWindow = inWindowRows.filter(([key]) => !seen.has(key)).length;
  const undeliveredShare = inWindowRows.length ? undeliveredInWindow / inWindowRows.length : 0;
  // A reader that never saw report_ready was stuck: its UI would never leave the room by itself.
  const readersWithoutReport = input.interviewIds.filter((_, iv) => !seen.has(`${iv}:r`)).length;
  const dropped = [...expected.keys()].filter((key) => !seen.has(key)).length;

  const firstFrameByIv = new Map<number, number>();
  for (const f of frames) {
    if (f.conn === 0 && !firstFrameByIv.has(f.iv)) {
      firstFrameByIv.set(f.iv, f.t);
    }
  }
  const ttff = conns
    .filter((c) => c.conn === 0 && firstFrameByIv.has(c.iv))
    .map((c) => firstFrameByIv.get(c.iv)! - c.requestedAt);
  const timeToOpen = conns.filter((c) => c.openedAt !== null).map((c) => c.openedAt! - c.requestedAt);

  const failedConnects = conns.filter((c) => c.status !== 200);
  // A 200 stream that ended without report_ready well before its server lifetime was cut short.
  const premature = conns.filter((c) =>
    c.status === 200 && !c.done && c.openedAt !== null && c.closedAt - c.openedAt < input.streamLifetimeMs - 5_000
  );
  const streamErrors = conns.filter((c) => c.status === 200 && c.error);
  const statusCounts: Record<string, number> = {};
  for (const c of conns) {
    statusCounts[String(c.status)] = (statusCounts[String(c.status)] ?? 0) + 1;
  }
  const lifetimeReconnects = conns.filter((c) => c.status === 200 && !c.done && !premature.includes(c)).length;

  const scheduledWrites = input.count * input.scheduledWritesPerInterview;
  const okWrites = writes.filter((w) => w.status >= 200 && w.status < 300);
  const failedWrites = writes.length - okWrites.length;
  const missingWrites = Math.max(0, scheduledWrites - writes.length);
  const writeStatusCounts: Record<string, number> = {};
  for (const w of writes) {
    writeStatusCounts[String(w.status)] = (writeStatusCounts[String(w.status)] ?? 0) + 1;
  }

  const errorEvents = failedConnects.length + premature.length + streamErrors.length + failedWrites + missingWrites;
  const errorOpportunities = conns.length + scheduledWrites;
  const errorRate = errorOpportunities ? errorEvents / errorOpportunities : 0;
  const edgeFunctionErrors = conns.filter((c) => c.status >= 500).length + writes.filter((w) => w.status >= 500).length +
    input.edgeErrorLines;

  const inWindow = input.samples.filter((s) => s.t >= windowStart && s.t <= windowEnd);
  const resources: Record<string, { cpuPct: Stats; cpuShareOfLimitP50: number | null; memMiBMax: number | null }> = {};
  for (const [name, cpus] of Object.entries(input.containerCpus)) {
    const cpu = inWindow.map((s) => s.containers[name]?.cpuPct).filter((v): v is number => typeof v === "number");
    const mem = inWindow.map((s) => s.containers[name]?.memMiB).filter((v): v is number => typeof v === "number");
    const cpuStats = stats(cpu);
    resources[name] = {
      cpuPct: cpuStats,
      cpuShareOfLimitP50: cpuStats.p50 === null ? null : Math.round((cpuStats.p50 / (cpus * 100)) * 1000) / 1000,
      memMiBMax: mem.length ? Math.round(Math.max(...mem)) : null,
    };
  }
  const pgActive = stats(inWindow.map((s) => s.pg?.active).filter((v): v is number => typeof v === "number"));
  const pgTotal = stats(inWindow.map((s) => s.pg?.total).filter((v): v is number => typeof v === "number"));

  const holdSeconds = input.holdMs / 1000;
  const byCategory: Record<string, { callsPerSec: number; meanMs: number | null }> = {};
  for (const st of input.statements) {
    const c = (byCategory[st.category] ??= { callsPerSec: 0, meanMs: 0 });
    c.callsPerSec += st.calls;
    c.meanMs! += st.totalMs;
  }
  for (const c of Object.values(byCategory)) {
    c.meanMs = c.callsPerSec ? Math.round((c.meanMs! / c.callsPerSec) * 1000) / 1000 : null;
    c.callsPerSec = Math.round((c.callsPerSec / holdSeconds) * 10) / 10;
  }

  const frameDelay = stats(windowDelays);
  const connectedDelay = stats(connectedDelays);
  const dbCpuShare = resources["supabase_db_stackprep"]?.cpuShareOfLimitP50 ?? null;
  const breaches: string[] = [];
  if (connectedDelay.p95 !== null && connectedDelay.p95 > input.thresholds.p95FrameDelayMs) {
    breaches.push(`p95 connected frame delay ${connectedDelay.p95} ms > ${input.thresholds.p95FrameDelayMs} ms`);
  }
  if (connectedDelay.count === 0) {
    breaches.push("no frames delivered in the measurement window");
  }
  if (undeliveredShare > input.thresholds.errorRate) {
    breaches.push(
      `${(undeliveredShare * 100).toFixed(1)}% of window rows never delivered > ${input.thresholds.errorRate * 100}%`,
    );
  }
  if (errorRate > input.thresholds.errorRate) {
    breaches.push(`error rate ${(errorRate * 100).toFixed(2)}% > ${input.thresholds.errorRate * 100}%`);
  }
  if (dbCpuShare !== null && dbCpuShare >= input.thresholds.cpuSaturationShare) {
    breaches.push(`DB CPU at ${(dbCpuShare * 100).toFixed(0)}% of its limit`);
  }
  if (input.edgeRuntimeCrash) {
    breaches.push(`edge runtime exited mid-run: ${input.edgeRuntimeCrash}`);
  }
  const saturated = Object.entries(resources)
    .filter(([, r]) => r.cpuShareOfLimitP50 !== null && r.cpuShareOfLimitP50 >= input.thresholds.cpuSaturationShare)
    .map(([name]) => name);

  return {
    count: input.count,
    window: { startAt: windowStart, endAt: windowEnd },
    clockOffsetMs: input.db.clockOffsetMs,
    /** All rows created in the window. */
    frameDelayMs: frameDelay,
    /** Rows created while the interview had an open stream; the bottleneck test uses this. */
    connectedFrameDelayMs: connectedDelay,
    /** Rows created while the interview was between connections. */
    reconnectGapFrameDelayMs: stats(gapDelays),
    completedStatusDelayMs: stats(completedDelays),
    reportReadyDelayMs: stats(reportDelays),
    timeToFirstFrameMs: stats(ttff),
    timeToOpenMs: stats(timeToOpen),
    frames: {
      expected: expected.size,
      receivedUnique: seen.size,
      dropped,
      duplicates,
      unexpected,
      malformed,
      readersWithoutReport,
      inWindowRows: inWindowRows.length,
      undeliveredInWindow,
      undeliveredInWindowShare: Math.round(undeliveredShare * 100000) / 100000,
    },
    connections: {
      attempts: conns.length,
      byStatus: statusCounts,
      failed: failedConnects.length,
      premature: premature.length,
      streamErrors: streamErrors.length,
      lifetimeReconnects,
      fallbacks: fallbacks.length,
      sampleErrors: [...new Set([...failedConnects, ...streamErrors].map((c) => c.error).filter(Boolean))].slice(0, 10),
    },
    writes: {
      scheduled: scheduledWrites,
      logged: writes.length,
      failed: failedWrites,
      missing: missingWrites,
      byStatus: writeStatusCounts,
      latencyMs: stats(writes.map((w) => w.endedAt - w.startedAt)),
      slipMs: stats(writes.map((w) => w.startedAt - w.plannedAt)),
    },
    errorRate: Math.round(errorRate * 100000) / 100000,
    edgeFunctionErrors,
    edgeWorkerLimitEvents: input.edgeWorkerLimitLines,
    edgeRuntimeCrash: input.edgeRuntimeCrash ?? null,
    db: { statementsByCategory: byCategory, activeConnections: pgActive, totalConnections: pgTotal },
    resources,
    saturatedContainers: saturated,
    breaches,
  };
}

export type RunMetrics = ReturnType<typeof analyzeRun>;

if (import.meta.main) {
  const { join } = await import("@std/path");
  const { readJson, writeJson } = await import("./lib.ts");
  const dir = Deno.args[0];
  const input = await readJson<Omit<RunInput, "records" | "samples" | "db" | "statements">>(join(dir, "run-input.json"));
  const parseNdjson = async <T>(file: string) =>
    (await Deno.readTextFile(join(dir, file))).split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as T);
  const metrics = analyzeRun({
    ...input,
    records: await parseNdjson<K6Record>("k6-events.ndjson"),
    samples: await parseNdjson<Sample>("samples.ndjson"),
    db: await readJson<DbRows>(join(dir, "db-rows.json")),
    statements: await readJson<StatementDelta[]>(join(dir, "pg-stat-statements.json")),
  });
  await writeJson(join(dir, "metrics.json"), metrics);
  console.log(JSON.stringify(metrics, null, 2));
}
