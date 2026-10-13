import type { Comparison, MetricComparison } from "./baseline.ts";
import { stableJson } from "./keys.ts";
import type { Metric, Provenance, RunResults } from "./types.ts";

export const RESULTS_FORMAT = 1;

/** latest.json: sorted keys, no timestamps, so two runs over the same inputs are byte-identical. */
export function resultsJson(results: RunResults): string {
  return stableJson(results);
}

export async function readResults(url: URL): Promise<RunResults> {
  const parsed = JSON.parse(await Deno.readTextFile(url)) as RunResults;
  if (parsed?.format !== RESULTS_FORMAT || !Array.isArray(parsed.suites)) {
    throw new Error(`results: ${url.pathname} is not a format ${RESULTS_FORMAT} results file`);
  }
  return parsed;
}

const PROVENANCE_MEANING: Record<Provenance, string> = {
  deterministic: "no model involved; recomputed exactly on every run",
  recorded_live: "computed from live model samples captured at record time; describes the model as of that recording",
  replay_reproducibility: "pipeline check over saved samples; says nothing about the model's current variability",
  judged: "involves a recorded judge; read it beside the judge's calibration metrics",
};

/** Fixed-precision number for reports: integers as is, others to 4 decimals with trailing zeros trimmed. */
export function formatNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  const fixed = value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  return fixed === "-0" ? "0" : fixed;
}

function formatDelta(delta: number | null): string {
  if (delta === null) return "";
  const text = formatNumber(delta);
  return delta > 0 && text !== "0" ? `+${text}` : text;
}

function formatCi(ci: [number, number] | undefined): string {
  return ci ? `[${formatNumber(ci[0])}, ${formatNumber(ci[1])}]` : "";
}

function cell(text: string): string {
  return text.replace(/[\\|]/g, "\\$&").replace(/\r?\n/g, " ");
}

function table(head: string[], rows: string[][]): string[] {
  return [
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`),
  ];
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

/** The Markdown report. Each corpus gets its own table; numbers from different corpora are never merged. */
export function renderReport(results: RunResults, comparison?: Comparison): string {
  const lines: string[] = [];
  const rows = new Map(comparison?.metrics.map((m) => [m.id, m]) ?? []);
  const metrics = results.suites.flatMap((s) => s.metrics.map((m) => ({ suite: s.id, metric: m })));

  lines.push(`# Eval report: ${results.project}`, "");
  lines.push(
    `Mode: ${results.mode}. Seed: ${results.seed}. Samples (K): ${results.samples}.${results.partial ? " Partial run: only some suites ran." : ""}`,
  );
  lines.push(`Integrity: ${results.integrity.ok ? "ok" : "FAILED"}.`);
  const r = results.recordings;
  lines.push(
    `Recordings: ${r.used} used (${r.replayed} replayed, ${r.recorded} recorded, ${r.live} live), set hash \`${r.setHash.slice(0, 12)}\`, ${r.misses.length} replay miss(es).`,
  );
  if (results.mode === "live") lines.push("", "This was a live run: nothing was recorded, so these numbers cannot be replayed or approved.");
  if (results.error) lines.push("", `**Run stopped:** ${results.error}`);
  lines.push("");

  lines.push("## Gate", "");
  if (!comparison || !comparison.hasBaseline) {
    lines.push("No approved baseline: every metric is informational.");
  } else if (comparison.blocking.length === 0) {
    lines.push("No blocking changes against the approved baseline.");
  } else {
    lines.push(`${comparison.blocking.length} blocking change(s):`, "");
    for (const m of comparison.blocking) lines.push(`- \`${m.id}\`: ${describeStatus(m)}`);
  }
  lines.push("");

  for (const corpus of sortedUnique(metrics.map((m) => m.metric.corpus))) {
    lines.push(`## Corpus: ${corpus}`, "");
    const inCorpus = metrics.filter((m) => m.metric.corpus === corpus);
    lines.push(...table(
      ["Metric", "Value", "95% CI", "n", "Provenance", "Gates", "Baseline", "Delta", "Status"],
      inCorpus.map(({ metric }) => metricRow(metric, rows.get(metric.id))),
    ));
    const notes = inCorpus.filter((m) => m.metric.note);
    if (notes.length > 0) {
      lines.push("", "Notes:", "");
      for (const { metric } of notes) lines.push(`- \`${metric.id}\`: ${metric.note}`);
    }
    lines.push("");
  }

  if (comparison) lines.push(...renderComparisonBody(comparison, { onlyChanges: true }));

  lines.push("## Suites", "");
  for (const suite of results.suites) {
    lines.push(`### ${suite.id}`, "");
    lines.push(`Status: ${suite.status}. Pins: ${suite.pins.length ? suite.pins.map((p) => `\`${p}\``).join(", ") : "none"}.`);
    if (suite.error) lines.push("", `Error: ${suite.error}`);
    if (suite.caveats.length > 0) {
      lines.push("", "Caveats:", "");
      for (const c of suite.caveats) lines.push(`- ${c}`);
    }
    if (suite.cases.length > 0) {
      const failed = suite.cases.filter((c) => !c.ok);
      lines.push("", `Cases: ${suite.cases.length - failed.length}/${suite.cases.length} ok.`);
      if (failed.length > 0) {
        lines.push("");
        for (const c of failed) lines.push(`- \`${c.id}\`${c.detail ? `: ${c.detail}` : ""}`);
      }
    }
    lines.push("");
  }

  lines.push("## Pins", "");
  lines.push(...table(
    ["Pin", "Kind", "Version", "Hash"],
    Object.keys(results.pins).sort().map((id) => {
      const p = results.pins[id];
      return [id, p.kind, p.version === null ? "unpinned" : `v${p.version}`, `\`${p.hash.slice(0, 12)}\``];
    }),
  ));
  lines.push("");
  if (results.integrity.problems.length > 0 || results.integrity.warnings.length > 0) {
    lines.push("Integrity findings:", "");
    for (const p of results.integrity.problems) lines.push(`- problem: ${p}`);
    for (const w of results.integrity.warnings) lines.push(`- warning: ${w}`);
    lines.push("");
  }
  if (r.misses.length > 0) {
    lines.push("Replay misses:", "");
    for (const m of r.misses) lines.push(`- ${m}`);
    lines.push("");
  }

  lines.push("## How to read these numbers", "");
  const used = new Set(metrics.map((m) => m.metric.provenance));
  for (const p of Object.keys(PROVENANCE_MEANING) as Provenance[]) {
    if (used.has(p)) lines.push(`- \`${p}\`: ${PROVENANCE_MEANING[p]}.`);
  }
  lines.push(
    "- A regression is a move in the bad direction beyond the baseline interval plus the metric's tolerance. Metrics that do not gate never fail the run.",
  );
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

function metricRow(metric: Metric, row: MetricComparison | undefined): string[] {
  return [
    `${metric.label} (\`${metric.id}\`)`,
    formatNumber(metric.value),
    formatCi(metric.ci),
    String(metric.n),
    metric.provenance,
    metric.gate ? "yes" : "no",
    row?.baseline ? formatNumber(row.baseline.value) : "",
    row ? formatDelta(row.delta) : "",
    row ? row.status : "",
  ];
}

function describeStatus(m: MetricComparison): string {
  const values = m.baseline && m.current
    ? ` (${formatNumber(m.baseline.value)} to ${formatNumber(m.current.value)})`
    : m.baseline
    ? ` (was ${formatNumber(m.baseline.value)})`
    : "";
  switch (m.status) {
    case "stale":
      return `pins changed since approval (${m.changedPins.join(", ")}); re-approve${values}`;
    case "missing":
      return `approved metric no longer produced${values}`;
    case "incompatible":
      return `direction, provenance or corpus changed since approval${values}`;
    default:
      return `${m.status}${values}`;
  }
}

/** Standalone comparison for `eval compare` and the approval preview. */
export function renderComparison(comparison: Comparison, options: { onlyIds?: readonly string[] } = {}): string {
  const scoped = options.onlyIds
    ? { ...comparison, metrics: comparison.metrics.filter((m) => options.onlyIds!.includes(m.id)) }
    : comparison;
  return `${renderComparisonBody(scoped, { onlyChanges: false }).join("\n").replace(/\n+$/, "")}\n`;
}

function renderComparisonBody(comparison: Comparison, options: { onlyChanges: boolean }): string[] {
  const lines: string[] = ["## Comparison with baseline", ""];
  if (!comparison.hasBaseline) lines.push("No approved baseline yet. Every metric below is new and informational.", "");
  const counts = new Map<string, number>();
  for (const m of comparison.metrics) counts.set(m.status, (counts.get(m.status) ?? 0) + 1);
  lines.push(
    `Blocking: ${comparison.metrics.filter((m) => m.blocking).length}. ` +
      ["regression", "improvement", "stale", "missing", "incompatible", "new", "unchanged"]
        .map((s) => `${s}: ${counts.get(s) ?? 0}`)
        .join(", ") +
      ".",
    "",
  );
  const shown = options.onlyChanges ? comparison.metrics.filter((m) => m.status !== "unchanged" || m.nChanged) : comparison.metrics;
  if (shown.length > 0) {
    lines.push(...table(
      ["Metric", "Corpus", "Baseline", "Current", "Delta", "n", "Status", "Blocks"],
      shown.map((m) => [
        `\`${m.id}\``,
        m.corpus,
        m.baseline ? `${formatNumber(m.baseline.value)} ${formatCi(m.baseline.ci)}`.trim() : "",
        m.current ? `${formatNumber(m.current.value)} ${formatCi(m.current.ci)}`.trim() : "",
        formatDelta(m.delta),
        m.baseline && m.current && m.nChanged ? `${m.baseline.n} to ${m.current.n}` : String(m.current?.n ?? m.baseline?.n ?? ""),
        m.status === "stale" ? `stale (${m.changedPins.join(", ")})` : m.status,
        m.blocking ? "yes" : "no",
      ]),
    ));
    lines.push("");
  }
  if (comparison.pinChanges.length > 0) {
    lines.push("Pin changes since the last approval:", "");
    for (const p of comparison.pinChanges) lines.push(`- \`${p.id}\`: ${pinLabel(p.baseline)} to ${pinLabel(p.current)}`);
    lines.push("");
  }
  if (comparison.configChanges.length > 0) {
    lines.push(`Config changes since the last approval: ${comparison.configChanges.map((c) => `${c.path} (${c.kind})`).join(", ")}.`, "");
  }
  if (comparison.seedChanged) lines.push("The seed differs from the last approval.", "");
  if (comparison.samplesChanged) lines.push("The sample count (K) differs from the last approval.", "");
  return lines;
}

function pinLabel(p: { version: number | null; hash: string } | null): string {
  if (!p) return "absent";
  return `${p.version === null ? "unpinned" : `v${p.version}`} \`${p.hash.slice(0, 12)}\``;
}
