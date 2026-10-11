import { type ComponentChange, componentDiff, stableJson } from "./keys.ts";
import type { EvalMode, Metric, PinSpec, RunResults } from "./types.ts";

export const BASELINE_FORMAT = 1;

/** Absorbs floating-point noise so recomputed equal values never read as a change. */
const EPSILON = 1e-9;

export interface BaselineMetric {
  suite: string;
  label: string;
  value: number;
  n: number;
  ci?: [number, number];
  direction: Metric["direction"];
  provenance: Metric["provenance"];
  corpus: string;
  gate: boolean;
  tolerance?: number;
  /** Hashes of the corpus pin and the suite's pins at approval; a change marks the baseline stale. */
  pins: Record<string, string>;
  /** Index into `approvals` of the approval that set this entry. */
  approval: number;
}

export interface ApprovedMetric {
  id: string;
  status: MetricStatus;
  before: number | null;
  after: number | null;
  delta: number | null;
}

export interface Approval {
  date: string;
  user: string;
  reason: string;
  gitSha: string;
  gitDirty: boolean;
  allowRegression: boolean;
  mode: EvalMode;
  seed: number;
  samples: number;
  config: Record<string, unknown>;
  pins: Record<string, { kind: PinSpec["kind"]; version: number | null; hash: string }>;
  recordingSetHash: string;
  metrics: ApprovedMetric[];
}

/** Contents of a project's baseline.json. Only `eval approve` writes it. */
export interface Baseline {
  format: number;
  project: string;
  metrics: Record<string, BaselineMetric>;
  /** Append-only approval history. */
  approvals: Approval[];
}

export type MetricStatus =
  | "new" // no approved baseline yet: informational
  | "missing" // approved, but the suite that produced it no longer emits it
  | "incompatible" // direction, provenance or corpus changed, so the numbers are not comparable
  | "stale" // a pin behind the metric changed since approval, so it needs re-approval
  | "regression"
  | "improvement"
  | "unchanged";

export interface MetricComparison {
  id: string;
  label: string;
  suite: string;
  corpus: string;
  provenance: Metric["provenance"];
  status: MetricStatus;
  /** Fails the gate. Only gated metrics with an approved baseline can block. */
  blocking: boolean;
  /** Worse than the baseline interval by more than the tolerance, whatever the status. */
  worse: boolean;
  baseline?: { value: number; ci?: [number, number]; n: number };
  current?: { value: number; ci?: [number, number]; n: number };
  delta: number | null;
  nChanged: boolean;
  /** Pin ids whose hash differs from the one recorded at approval. */
  changedPins: string[];
}

export interface PinChange {
  id: string;
  baseline: { version: number | null; hash: string } | null;
  current: { version: number | null; hash: string } | null;
}

export interface Comparison {
  hasBaseline: boolean;
  metrics: MetricComparison[];
  blocking: MetricComparison[];
  /** Pins that differ from the latest approval. */
  pinChanges: PinChange[];
  configChanges: ComponentChange[];
  seedChanged: boolean;
  samplesChanged: boolean;
}

export function emptyBaseline(project: string): Baseline {
  return { format: BASELINE_FORMAT, project, metrics: {}, approvals: [] };
}

interface CurrentMetric {
  suite: string;
  metric: Metric;
  pins: Record<string, string>;
}

function currentMetrics(results: RunResults): Map<string, CurrentMetric> {
  const out = new Map<string, CurrentMetric>();
  for (const suite of results.suites) {
    if (suite.status !== "ok") continue;
    for (const metric of suite.metrics) {
      const pins: Record<string, string> = {};
      for (const id of [metric.corpus, ...suite.pins].sort()) {
        const pin = results.pins[id];
        if (pin) pins[id] = pin.hash;
      }
      out.set(metric.id, { suite: suite.id, metric, pins });
    }
  }
  return out;
}

/** Worse or better than the baseline interval (or value, without one) by more than the tolerance. */
function movement(base: BaselineMetric, value: number, tolerance: number): { worse: boolean; better: boolean } {
  const lo = base.ci ? base.ci[0] : base.value;
  const hi = base.ci ? base.ci[1] : base.value;
  if (base.direction === "higher_is_better") {
    return { worse: value < lo - tolerance - EPSILON, better: value > hi + tolerance + EPSILON };
  }
  return { worse: value > hi + tolerance + EPSILON, better: value < lo - tolerance - EPSILON };
}

function changedPinIds(before: Record<string, string>, after: Record<string, string>): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((id) => before[id] !== after[id]).sort();
}

/**
 * Compares a run with the approved baseline. A regression is a move in the bad direction beyond the baseline
 * interval plus the metric's tolerance, not any drop. Without a baseline entry a metric never blocks.
 */
export function compare(results: RunResults, baseline: Baseline | undefined): Comparison {
  const base = baseline?.metrics ?? {};
  const current = currentMetrics(results);
  const ranSuites = new Set(results.suites.map((s) => s.id));
  const metrics: MetricComparison[] = [];

  for (const [id, { suite, metric, pins }] of current) {
    const b = base[id];
    const cur = { value: metric.value, ci: metric.ci, n: metric.n };
    if (!b) {
      metrics.push({
        id,
        label: metric.label,
        suite,
        corpus: metric.corpus,
        provenance: metric.provenance,
        status: "new",
        blocking: false,
        worse: false,
        current: cur,
        delta: null,
        nChanged: false,
        changedPins: [],
      });
      continue;
    }
    const comparable = b.direction === metric.direction && b.provenance === metric.provenance && b.corpus === metric.corpus;
    const { worse, better } = comparable ? movement(b, metric.value, metric.tolerance ?? 0) : { worse: false, better: false };
    const changedPins = changedPinIds(b.pins, pins);
    const status: MetricStatus = !comparable
      ? "incompatible"
      : changedPins.length > 0
      ? "stale"
      : worse
      ? "regression"
      : better
      ? "improvement"
      : "unchanged";
    metrics.push({
      id,
      label: metric.label,
      suite,
      corpus: metric.corpus,
      provenance: metric.provenance,
      status,
      blocking: metric.gate && (status === "regression" || status === "stale" || status === "incompatible"),
      worse,
      baseline: { value: b.value, ci: b.ci, n: b.n },
      current: cur,
      delta: metric.value - b.value,
      nChanged: b.n !== metric.n,
      changedPins,
    });
  }

  for (const id of Object.keys(base)) {
    const b = base[id];
    if (current.has(id)) continue;
    // A partial run says nothing about suites it skipped.
    if (results.partial && !ranSuites.has(b.suite)) continue;
    metrics.push({
      id,
      label: b.label,
      suite: b.suite,
      corpus: b.corpus,
      provenance: b.provenance,
      status: "missing",
      blocking: b.gate,
      worse: false,
      baseline: { value: b.value, ci: b.ci, n: b.n },
      delta: null,
      nChanged: false,
      changedPins: [],
    });
  }

  metrics.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const last = baseline?.approvals.at(-1);
  return {
    hasBaseline: Object.keys(base).length > 0,
    metrics,
    blocking: metrics.filter((m) => m.blocking),
    pinChanges: last ? pinChanges(last.pins, results.pins) : [],
    configChanges: last ? componentDiff(last.config, results.config) : [],
    seedChanged: last ? last.seed !== results.seed : false,
    samplesChanged: last ? last.samples !== results.samples : false,
  };
}

function pinChanges(before: Approval["pins"], after: RunResults["pins"]): PinChange[] {
  const out: PinChange[] = [];
  for (const id of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const b = before[id];
    const a = after[id];
    if (b && a && b.hash === a.hash) continue;
    out.push({
      id,
      baseline: b ? { version: b.version, hash: b.hash } : null,
      current: a ? { version: a.version, hash: a.hash } : null,
    });
  }
  return out;
}

export class ApprovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalError";
  }
}

export interface ApproveOptions {
  /** Metric ids to approve, or "all" for every metric in the run plus every missing one (which removes it). */
  metrics: readonly string[] | "all";
  reason: string;
  allowRegression: boolean;
  /** True when running in CI; approval is always refused there. */
  ci: boolean;
  /** Pin id to hash computed from disk now, to catch results produced from other pins. */
  currentPins: Record<string, string>;
  date: string;
  user: string;
  gitSha: string;
  gitDirty: boolean;
}

export interface ApproveOutcome {
  baseline: Baseline;
  approval: Approval;
  /** Comparison rows for the selected metrics only. */
  selected: MetricComparison[];
}

/**
 * Builds the next baseline from a run. Pure: the caller shows the diff, asks for confirmation and writes.
 * Refuses in CI, without a reason, on pin mismatch, on live or failed runs, and on any worse, missing or
 * incompatible metric unless `allowRegression` is set.
 */
export function approve(results: RunResults, baseline: Baseline | undefined, options: ApproveOptions): ApproveOutcome {
  if (options.ci) throw new ApprovalError("eval approve refuses to run in CI; baselines change only through a reviewed local approval");
  const reason = options.reason.trim();
  if (!reason) throw new ApprovalError('a reason is required: --reason "<why these numbers are the new baseline>"');
  if (!results.integrity.ok) {
    throw new ApprovalError(`the run failed pin integrity: ${results.integrity.problems.join("; ") || results.error}`);
  }
  const mismatched = changedPinIds(
    Object.fromEntries(Object.entries(results.pins).map(([id, p]) => [id, p.hash])),
    options.currentPins,
  );
  if (mismatched.length > 0) {
    throw new ApprovalError(`latest.json was produced from different pins than are on disk now (${mismatched.join(", ")}); re-run first`);
  }
  if (results.mode === "live") {
    throw new ApprovalError("live runs are not recorded and cannot be replayed; approve from a replay or record run");
  }
  if (results.error) throw new ApprovalError(`the run did not complete: ${results.error}`);
  const failed = results.suites.filter((s) => s.status !== "ok").map((s) => s.id);
  if (failed.length > 0) throw new ApprovalError(`suites failed: ${failed.join(", ")}`);
  if (results.recordings.misses.length > 0) throw new ApprovalError(`the run had ${results.recordings.misses.length} replay miss(es)`);
  if (baseline && baseline.project !== results.project) {
    throw new ApprovalError(`baseline is for project "${baseline.project}", results are for "${results.project}"`);
  }

  const comparison = compare(results, baseline);
  const byId = new Map(comparison.metrics.map((m) => [m.id, m]));
  const ids = options.metrics === "all" ? [...byId.keys()] : [...new Set(options.metrics)].sort();
  if (ids.length === 0) throw new ApprovalError("no metrics selected");
  const unknown = ids.filter((id) => !byId.has(id));
  if (unknown.length > 0) throw new ApprovalError(`unknown metric id(s): ${unknown.join(", ")}`);
  const selected = ids.map((id) => byId.get(id)!);

  const needsFlag = selected.filter((m) => m.worse || m.status === "missing" || m.status === "incompatible");
  if (needsFlag.length > 0 && !options.allowRegression) {
    throw new ApprovalError(
      `approving would accept a regression, removal or incompatible change in: ${needsFlag.map((m) => `${m.id} (${m.status})`).join(", ")}. ` +
        "Pass --allow-regression with a reason that explains why.",
    );
  }

  const prior = baseline ?? emptyBaseline(results.project);
  const index = prior.approvals.length;
  const current = currentMetrics(results);
  const metrics: Record<string, BaselineMetric> = { ...prior.metrics };
  for (const m of selected) {
    const cur = current.get(m.id);
    if (!cur) {
      delete metrics[m.id];
      continue;
    }
    const { metric } = cur;
    metrics[m.id] = {
      suite: cur.suite,
      label: metric.label,
      value: metric.value,
      n: metric.n,
      ci: metric.ci,
      direction: metric.direction,
      provenance: metric.provenance,
      corpus: metric.corpus,
      gate: metric.gate,
      tolerance: metric.tolerance,
      pins: cur.pins,
      approval: index,
    };
  }

  const approval: Approval = {
    date: options.date,
    user: options.user,
    reason,
    gitSha: options.gitSha,
    gitDirty: options.gitDirty,
    allowRegression: options.allowRegression,
    mode: results.mode,
    seed: results.seed,
    samples: results.samples,
    config: results.config,
    pins: results.pins,
    recordingSetHash: results.recordings.setHash,
    metrics: selected.map((m) => ({
      id: m.id,
      status: m.status,
      before: m.baseline?.value ?? null,
      after: m.current?.value ?? null,
      delta: m.delta,
    })),
  };
  return {
    baseline: { format: BASELINE_FORMAT, project: results.project, metrics, approvals: [...prior.approvals, approval] },
    approval,
    selected,
  };
}

export async function readBaseline(url: URL): Promise<Baseline | undefined> {
  let text: string;
  try {
    text = await Deno.readTextFile(url);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
  const parsed = JSON.parse(text) as Baseline;
  if (parsed?.format !== BASELINE_FORMAT || typeof parsed.metrics !== "object" || !Array.isArray(parsed.approvals)) {
    throw new Error(`baseline: ${url.pathname} is not a format ${BASELINE_FORMAT} baseline`);
  }
  return parsed;
}

export function writeBaseline(url: URL, baseline: Baseline): Promise<void> {
  return Deno.writeTextFile(url, stableJson(baseline));
}
