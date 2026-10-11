// Aggregates runs/<stage>-r<n>/metrics.json into summary.json and summary.md: per stage, the
// median of the repeated runs with the min-max spread, and the first stage that breaches the
// bottleneck definition in config.json.
import { join } from "@std/path";
import type { RunMetrics } from "./analyze.ts";
import { LOADTEST_DIR, median, readJson, writeJson } from "./lib.ts";

interface Spread {
  median: number | null;
  min: number | null;
  max: number | null;
}

function spread(values: (number | null | undefined)[]): Spread {
  const v = values.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
  if (v.length === 0) {
    return { median: null, min: null, max: null };
  }
  const r = (x: number | null) => (x === null ? null : Math.round(x * 1000) / 1000);
  return { median: r(median(v)), min: r(Math.min(...v)), max: r(Math.max(...v)) };
}

const METRICS: [string, (m: RunMetrics) => number | null | undefined][] = [
  ["connected frame delay p50 (ms)", (m) => m.connectedFrameDelayMs.p50],
  ["connected frame delay p95 (ms)", (m) => m.connectedFrameDelayMs.p95],
  ["connected frame delay p99 (ms)", (m) => m.connectedFrameDelayMs.p99],
  ["all-rows frame delay p95 (ms)", (m) => m.frameDelayMs.p95],
  ["all-rows frame delay p99 (ms)", (m) => m.frameDelayMs.p99],
  ["reconnect-gap rows (count)", (m) => m.reconnectGapFrameDelayMs.count],
  ["reconnect-gap frame delay p95 (ms)", (m) => m.reconnectGapFrameDelayMs.p95],
  ["completed status delay p95 (ms)", (m) => m.completedStatusDelayMs.p95],
  ["report_ready delay p95 (ms)", (m) => m.reportReadyDelayMs.p95],
  ["time to first frame p50 (ms)", (m) => m.timeToFirstFrameMs.p50],
  ["time to first frame p95 (ms)", (m) => m.timeToFirstFrameMs.p95],
  ["time to open p95 (ms)", (m) => m.timeToOpenMs.p95],
  ["window rows never delivered (%)", (m) => m.frames.undeliveredInWindowShare * 100],
  ["dropped frames (whole run)", (m) => m.frames.dropped],
  ["duplicate frames", (m) => m.frames.duplicates],
  ["readers that never got report_ready", (m) => m.frames.readersWithoutReport],
  ["connection attempts", (m) => m.connections.attempts],
  ["failed connects", (m) => m.connections.failed],
  ["premature closes", (m) => m.connections.premature],
  ["polling fallbacks", (m) => m.connections.fallbacks],
  ["failed writes", (m) => m.writes.failed + m.writes.missing],
  ["write latency p95 (ms)", (m) => m.writes.latencyMs.p95],
  ["write schedule slip p95 (ms)", (m) => m.writes.slipMs.p95],
  ["error rate (%)", (m) => m.errorRate * 100],
  ["edge function errors", (m) => m.edgeFunctionErrors],
  ["edge worker limit events", (m) => m.edgeWorkerLimitEvents],
  ["edge runtime crashed (share of runs)", (m) => (m.edgeRuntimeCrash ? 1 : 0)],
  ["stream poll queries/s", (m) => m.db.statementsByCategory.stream_poll?.callsPerSec ?? 0],
  ["stream poll mean exec (ms)", (m) => m.db.statementsByCategory.stream_poll?.meanMs],
  ["interview lookups/s", (m) => m.db.statementsByCategory.interview_lookup?.callsPerSec ?? 0],
  ["all DB statements/s", (m) => Object.values(m.db.statementsByCategory).reduce((s, c) => s + c.callsPerSec, 0)],
  ["DB active connections p50", (m) => m.db.activeConnections.p50],
  ["DB total connections max", (m) => m.db.totalConnections.max],
  ["db CPU p50 (% of 1 core)", (m) => m.resources.supabase_db_stackprep?.cpuPct.p50],
  ["db CPU p95 (% of 1 core)", (m) => m.resources.supabase_db_stackprep?.cpuPct.p95],
  ["edge runtime CPU p50 (% of 1 core)", (m) => m.resources.supabase_edge_runtime_stackprep?.cpuPct.p50],
  ["edge runtime CPU p95 (% of 1 core)", (m) => m.resources.supabase_edge_runtime_stackprep?.cpuPct.p95],
  ["edge runtime memory max (MiB)", (m) => m.resources.supabase_edge_runtime_stackprep?.memMiBMax],
  ["auth CPU p50 (% of 1 core)", (m) => m.resources.supabase_auth_stackprep?.cpuPct.p50],
  ["rest CPU p50 (% of 1 core)", (m) => m.resources.supabase_rest_stackprep?.cpuPct.p50],
  ["kong CPU p50 (% of 1 core)", (m) => m.resources.supabase_kong_stackprep?.cpuPct.p50],
  ["realtime CPU p50 (% of 1 core)", (m) => m.resources.supabase_realtime_stackprep?.cpuPct.p50],
];

export async function summarize(outDir: string) {
  const runsDir = join(outDir, "runs");
  const byStage = new Map<number, { name: string; metrics: RunMetrics }[]>();
  for await (const entry of Deno.readDir(runsDir)) {
    if (!entry.isDirectory) {
      continue;
    }
    const metrics = await readJson<RunMetrics>(join(runsDir, entry.name, "metrics.json")).catch(() => null);
    if (metrics) {
      const list = byStage.get(metrics.count) ?? [];
      list.push({ name: entry.name, metrics });
      byStage.set(metrics.count, list);
    }
  }
  const env = await readJson<Record<string, unknown> & { config: { bottleneck: Record<string, number> } }>(
    join(outDir, "environment.json"),
  );
  const t = env.config.bottleneck;

  const stages = [...byStage.keys()].sort((a, b) => a - b).map((count) => {
    const runs = byStage.get(count)!.sort((a, b) => a.name.localeCompare(b.name));
    const table = Object.fromEntries(METRICS.map(([label, get]) => [label, spread(runs.map((r) => get(r.metrics)))]));
    const p95 = table["connected frame delay p95 (ms)"].median;
    const errorPct = table["error rate (%)"].median;
    const undeliveredPct = table["window rows never delivered (%)"].median;
    const dbShare = median(runs.map((r) => r.metrics.resources.supabase_db_stackprep?.cpuShareOfLimitP50 ?? 0));
    const causes: string[] = [];
    if (p95 === null || p95 > t.p95FrameDelayMs) {
      causes.push(`median p95 connected frame delay ${p95 ?? "n/a"} ms > ${t.p95FrameDelayMs} ms`);
    }
    if (undeliveredPct !== null && undeliveredPct > t.errorRate * 100) {
      causes.push(`median ${undeliveredPct.toFixed(1)}% of window rows never delivered > ${t.errorRate * 100}%`);
    }
    if (errorPct !== null && errorPct > t.errorRate * 100) {
      causes.push(`median error rate ${errorPct.toFixed(2)}% > ${t.errorRate * 100}%`);
    }
    if (dbShare !== null && dbShare >= t.cpuSaturationShare) {
      causes.push(`DB CPU at ${(dbShare * 100).toFixed(0)}% of its limit`);
    }
    const crashes = runs.filter((r) => r.metrics.edgeRuntimeCrash);
    if (crashes.length > 0) {
      causes.push(`edge runtime exited mid-run in ${crashes.length} of ${runs.length} runs (${crashes[0].metrics.edgeRuntimeCrash})`);
    }
    const saturated = [...new Set(runs.flatMap((r) => r.metrics.saturatedContainers))];
    return { count, runs: runs.map((r) => r.name), table, breached: causes.length > 0, causes, saturatedContainers: saturated };
  });

  const firstBreach = stages.find((s) => s.breached) ?? null;
  const summary = {
    generatedAt: new Date().toISOString(),
    environment: env,
    bottleneckDefinition:
      `First stage where the median (over runs) p95 connected frame delay exceeds ${t.p95FrameDelayMs} ms, more than ` +
      `${t.errorRate * 100}% of the rows written in the measurement window are never delivered, the median error rate ` +
      `exceeds ${t.errorRate * 100}%, or the DB container's median CPU reaches ${t.cpuSaturationShare * 100}% of its ` +
      "limit. Delay percentiles cover delivered frames only, which is why undelivered rows are a separate test. " +
      "Connected delay covers rows created while the interview had an open stream; rows created during " +
      "the SSE lifetime reconnect (140 s stream, 3 s client retry) are reported separately as reconnect-gap delay and " +
      "included in the all-rows figures.",
    bottleneck: firstBreach
      ? { concurrency: firstBreach.count, causes: firstBreach.causes, saturatedContainers: firstBreach.saturatedContainers }
      : null,
    stages,
  };
  await writeJson(join(outDir, "summary.json"), summary);
  await Deno.writeTextFile(join(outDir, "summary.md"), renderMarkdown(summary));
  return summary;
}

function fmt(s: Spread): string {
  if (s.median === null) {
    return "n/a";
  }
  const n = (x: number) => (Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 10 ? x.toFixed(1) : x.toFixed(2));
  return s.min === s.max ? n(s.median) : `${n(s.median)} (${n(s.min!)}-${n(s.max!)})`;
}

interface SummaryDoc {
  environment: Record<string, unknown>;
  bottleneckDefinition: string;
  bottleneck: { concurrency: number; causes: string[]; saturatedContainers: string[] } | null;
  stages: { count: number; table: Record<string, Spread>; breached: boolean }[];
}

function renderMarkdown(summary: SummaryDoc): string {
  const counts = summary.stages.map((s) => s.count);
  const lines = [
    `# Interview events load test: ${String(summary.environment.transport).toUpperCase()}`,
    "",
    "Generated by `loadtest/summarize.ts` from `runs/*/metrics.json`. Each cell is the median over the runs at that " +
    "concurrency, with the min-max spread in parentheses. Local Docker numbers are relative, not production capacity.",
    "",
    `**Bottleneck definition.** ${summary.bottleneckDefinition}`,
    "",
    summary.bottleneck
      ? `**Result.** First breach at **${summary.bottleneck.concurrency}** concurrent interviews: ${
        summary.bottleneck.causes.join("; ")
      }.${
        summary.bottleneck.saturatedContainers.length
          ? ` Containers at or above the CPU saturation share: ${summary.bottleneck.saturatedContainers.join(", ")}.`
          : ""
      }`
      : `**Result.** No stage breached the definition up to ${Math.max(...counts)} concurrent interviews.`,
    "",
    `| Metric | ${counts.join(" | ")} |`,
    `| --- | ${counts.map(() => "---").join(" | ")} |`,
    ...METRICS.map(([label]) => `| ${label} | ${summary.stages.map((s) => fmt(s.table[label])).join(" | ")} |`),
    `| breached | ${summary.stages.map((s) => (s.breached ? "yes" : "no")).join(" | ")} |`,
    "",
  ];
  return lines.join("\n");
}

if (import.meta.main) {
  const dir = Deno.args[0] ?? "results/sse-baseline";
  const summary = await summarize(join(LOADTEST_DIR, dir));
  console.log(JSON.stringify(summary.bottleneck));
}
