import { assert, assertEquals, assertThrows } from "@std/assert";
import { type ApproveOptions, approve, ApprovalError, type Baseline, compare } from "./baseline.ts";
import type { Metric, RunResults } from "./types.ts";

function metric(id: string, value: number, extra: Partial<Metric> = {}): Metric {
  return {
    id,
    label: id,
    value,
    n: 40,
    direction: "higher_is_better",
    provenance: "deterministic",
    corpus: "synthetic",
    gate: true,
    ...extra,
  };
}

function results(metrics: Metric[], extra: Partial<RunResults> = {}): RunResults {
  return {
    format: 1,
    project: "demo",
    mode: "replay",
    seed: 1,
    samples: 3,
    config: { model: "m1" },
    partial: false,
    pins: {
      synthetic: { kind: "corpus", version: 1, hash: "c1" },
      "dataset.a": { kind: "dataset", version: 1, hash: "d1" },
      recordings: { kind: "recordings", version: 1, hash: "r1" },
    },
    integrity: { ok: true, problems: [], warnings: [] },
    recordings: { setHash: "set", used: 2, replayed: 2, recorded: 0, live: 0, misses: [] },
    suites: [{ id: "alpha", pins: ["dataset.a"], status: "ok", metrics, cases: [], caveats: [] }],
    ...extra,
  };
}

const PINS_NOW = { synthetic: "c1", "dataset.a": "d1", recordings: "r1" };

function options(extra: Partial<ApproveOptions> = {}): ApproveOptions {
  return {
    metrics: "all",
    reason: "first labelled baseline",
    allowRegression: false,
    ci: false,
    currentPins: PINS_NOW,
    date: "2026-10-11T06:00:00.000Z",
    user: "Tester <t@example.com>",
    gitSha: "abc123",
    gitDirty: false,
    ...extra,
  };
}

function approved(metrics: Metric[]): Baseline {
  return approve(results(metrics), undefined, options()).baseline;
}

function statusOf(r: RunResults, b: Baseline | undefined, id: string) {
  return compare(r, b).metrics.find((m) => m.id === id)!;
}

Deno.test("without a baseline every metric is new and nothing blocks", () => {
  const c = compare(results([metric("a", 0.5)]), undefined);
  assertEquals(c.hasBaseline, false);
  assertEquals(c.metrics.map((m) => [m.status, m.blocking]), [["new", false]]);
});

Deno.test("a drop inside the baseline interval or tolerance is not a regression", () => {
  const base = approved([metric("a", 0.8, { ci: [0.7, 0.9] }), metric("b", 0.8, { tolerance: 0.05 })]);
  assertEquals(statusOf(results([metric("a", 0.71), metric("b", 0.76, { tolerance: 0.05 })]), base, "a").status, "unchanged");
  assertEquals(statusOf(results([metric("a", 0.71), metric("b", 0.76, { tolerance: 0.05 })]), base, "b").status, "unchanged");
  const worse = compare(results([metric("a", 0.69), metric("b", 0.74, { tolerance: 0.05 })]), base);
  assertEquals(worse.metrics.map((m) => [m.id, m.status, m.blocking]), [["a", "regression", true], ["b", "regression", true]]);
  assertEquals(worse.blocking.length, 2);
});

Deno.test("lower_is_better metrics regress upwards", () => {
  const lower = { direction: "lower_is_better" as const };
  const base = approved([metric("fp", 0.1, lower)]);
  assertEquals(statusOf(results([metric("fp", 0.2, lower)]), base, "fp").status, "regression");
  assertEquals(statusOf(results([metric("fp", 0.05, lower)]), base, "fp").status, "improvement");
});

Deno.test("floating-point noise is not a change", () => {
  const base = approved([metric("a", 0.1 + 0.2)]);
  assertEquals(statusOf(results([metric("a", 0.3)]), base, "a").status, "unchanged");
});

Deno.test("informational metrics are compared but never block", () => {
  const base = approved([metric("a", 0.8, { gate: false })]);
  const row = statusOf(results([metric("a", 0.1, { gate: false })]), base, "a");
  assertEquals([row.status, row.blocking], ["regression", false]);
});

Deno.test("missing gated metrics block; a partial run ignores suites it skipped", () => {
  const base = approved([metric("a", 0.8)]);
  const gone = compare(results([]), base);
  assertEquals(gone.metrics.map((m) => [m.id, m.status, m.blocking]), [["a", "missing", true]]);

  const skipped = results([], { partial: true, suites: [{ id: "beta", pins: [], status: "ok", metrics: [], cases: [], caveats: [] }] });
  assertEquals(compare(skipped, base).metrics, []);
});

Deno.test("a changed pin behind a metric marks it stale until re-approved", () => {
  const base = approved([metric("a", 0.8)]);
  const r = results([metric("a", 0.8)]);
  r.pins["dataset.a"] = { kind: "dataset", version: 2, hash: "d2" };
  const row = statusOf(r, base, "a");
  assertEquals([row.status, row.blocking, row.changedPins], ["stale", true, ["dataset.a"]]);
  assertEquals(compare(r, base).pinChanges, [{ id: "dataset.a", baseline: { version: 1, hash: "d1" }, current: { version: 2, hash: "d2" } }]);
});

Deno.test("changing direction, provenance or corpus is incompatible, not a silent comparison", () => {
  const base = approved([metric("a", 0.8)]);
  assertEquals(statusOf(results([metric("a", 0.8, { provenance: "judged" })]), base, "a").status, "incompatible");
  const r = results([metric("a", 0.8, { corpus: "snapshot" })]);
  r.pins.snapshot = { kind: "corpus", version: 1, hash: "s1" };
  assertEquals(statusOf(r, base, "a").status, "incompatible");
});

Deno.test("comparison reports n, config, seed and sample changes", () => {
  const base = approved([metric("a", 0.8)]);
  const c = compare(results([metric("a", 0.8, { n: 41 })], { config: { model: "m2" }, seed: 2, samples: 5 }), base);
  assertEquals(c.metrics[0].nChanged, true);
  assertEquals(c.configChanges, [{ path: "model", kind: "changed" }]);
  assert(c.seedChanged && c.samplesChanged);
});

Deno.test("approve records metadata, per-metric deltas and pins", () => {
  const first = approve(results([metric("a", 0.5, { ci: [0.4, 0.6] })]), undefined, options());
  const { baseline, approval } = approve(results([metric("a", 0.7)]), first.baseline, options({ reason: "better ranking", gitDirty: true }));
  assertEquals(baseline.approvals.length, 2);
  assertEquals(approval, {
    date: "2026-10-11T06:00:00.000Z",
    user: "Tester <t@example.com>",
    reason: "better ranking",
    gitSha: "abc123",
    gitDirty: true,
    allowRegression: false,
    mode: "replay",
    seed: 1,
    samples: 3,
    config: { model: "m1" },
    pins: results([]).pins,
    recordingSetHash: "set",
    metrics: [{ id: "a", status: "improvement", before: 0.5, after: 0.7, delta: 0.7 - 0.5 }],
  });
  assertEquals(baseline.metrics.a.value, 0.7);
  assertEquals(baseline.metrics.a.approval, 1);
  assertEquals(baseline.metrics.a.pins, { "dataset.a": "d1", synthetic: "c1" });
  assertEquals(baseline.metrics.a.suite, "alpha");
});

Deno.test("approve with selected ids leaves the others untouched", () => {
  const base = approved([metric("a", 0.5), metric("b", 0.5)]);
  const next = approve(results([metric("a", 0.9), metric("b", 0.9)]), base, options({ metrics: ["b"] })).baseline;
  assertEquals([next.metrics.a.value, next.metrics.b.value], [0.5, 0.9]);
});

Deno.test("approve refuses in CI, without a reason, on pin mismatch, on live, failed or missed runs", () => {
  const r = results([metric("a", 0.5)]);
  const refusals: Array<[RunResults, Partial<ApproveOptions>, string]> = [
    [r, { ci: true }, "CI"],
    [r, { reason: "   " }, "reason"],
    [results([metric("a", 0.5)], { integrity: { ok: false, problems: ["dataset.a: stale"], warnings: [] } }), {}, "integrity"],
    [r, { currentPins: { ...PINS_NOW, "dataset.a": "d2" } }, "different pins"],
    [results([metric("a", 0.5)], { mode: "live" }), {}, "live"],
    [results([], { suites: [{ id: "alpha", pins: [], status: "error", error: "boom", metrics: [], cases: [], caveats: [] }] }), {}, "suites failed"],
    [results([metric("a", 0.5)], { recordings: { setHash: "s", used: 1, replayed: 0, recorded: 0, live: 0, misses: ["miss"] } }), {}, "replay miss"],
    [results([metric("a", 0.5)], { error: "setup failed" }), {}, "did not complete"],
    [r, { metrics: ["zzz"] }, "unknown metric"],
    [r, { metrics: [] }, "no metrics"],
  ];
  for (const [res, opts, text] of refusals) {
    assertThrows(() => approve(res, undefined, options(opts)), ApprovalError, text);
  }
  const other = { ...approved([metric("a", 0.5)]), project: "other" };
  assertThrows(() => approve(r, other, options()), ApprovalError, "project");
});

Deno.test("approving a regression, removal or incompatible change needs --allow-regression", () => {
  const base = approved([metric("a", 0.8), metric("b", 0.8)]);
  const worse = results([metric("a", 0.5)]);
  const error = assertThrows(() => approve(worse, base, options()), ApprovalError);
  assert(error.message.includes("a (regression)") && error.message.includes("b (missing)"));
  assertThrows(() => approve(results([metric("a", 0.8, { provenance: "judged" }), metric("b", 0.8)]), base, options()), ApprovalError, "incompatible");

  const { baseline, approval } = approve(worse, base, options({ allowRegression: true, reason: "dropped flaky metric b" }));
  assertEquals(Object.keys(baseline.metrics), ["a"]);
  assertEquals(approval.allowRegression, true);
  assertEquals(approval.metrics.map((m) => [m.id, m.status]), [["a", "regression"], ["b", "missing"]]);
});

Deno.test("re-approving a stale metric with an unchanged value needs no flag", () => {
  const base = approved([metric("a", 0.8)]);
  const r = results([metric("a", 0.8)]);
  r.pins["dataset.a"] = { kind: "dataset", version: 2, hash: "d2" };
  const next = approve(r, base, options({ currentPins: { ...PINS_NOW, "dataset.a": "d2" } })).baseline;
  assertEquals(next.metrics.a.pins["dataset.a"], "d2");
  assertEquals(statusOf(r, next, "a").status, "unchanged");
});
