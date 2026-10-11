import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { approve, compare } from "./baseline.ts";
import { formatNumber, renderComparison, renderReport, resultsJson } from "./report.ts";
import type { Metric, RunResults } from "./types.ts";

function metric(id: string, value: number, corpus: string, extra: Partial<Metric> = {}): Metric {
  return { id, label: `Label ${id}`, value, n: 10, direction: "higher_is_better", provenance: "deterministic", corpus, gate: true, ...extra };
}

function results(metrics: Metric[]): RunResults {
  return {
    format: 1,
    project: "demo",
    mode: "replay",
    seed: 1,
    samples: 1,
    config: { model: "m1" },
    partial: false,
    pins: {
      synthetic: { kind: "corpus", version: 1, hash: "aaaaaaaaaaaaaaaa" },
      snapshot: { kind: "corpus", version: 2, hash: "bbbbbbbbbbbbbbbb" },
    },
    integrity: { ok: true, problems: [], warnings: [] },
    recordings: { setHash: "cccccccccccccccc", used: 3, replayed: 3, recorded: 0, live: 0, misses: [] },
    suites: [{
      id: "retrieval",
      pins: ["snapshot", "synthetic"],
      status: "ok",
      metrics,
      cases: [{ id: "q1", ok: true }, { id: "q2", ok: false, detail: "expected a.ts | got b.ts" }],
      caveats: ["SQL symbol ranking is not exercised offline."],
    }],
  };
}

Deno.test("formatNumber is stable and trims", () => {
  assertEquals([formatNumber(1), formatNumber(0.5), formatNumber(1 / 3), formatNumber(-0.00001), formatNumber(0.1 + 0.2)], ["1", "0.5", "0.3333", "0", "0.3"]);
});

Deno.test("resultsJson sorts keys, ends with a newline and ignores key insertion order", () => {
  const a = results([metric("m", 0.5, "synthetic")]);
  const b = JSON.parse(JSON.stringify(a), (_k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).reverse()) : v));
  assertEquals(resultsJson(a), resultsJson(b));
  assert(resultsJson(a).endsWith("}\n"));
  assert(resultsJson(a).indexOf('"config"') < resultsJson(a).indexOf('"suites"'));
});

Deno.test("report keeps corpora in separate tables and explains provenance", () => {
  const r = results([
    metric("retrieval.recall_at_5.synthetic", 0.8, "synthetic", { ci: [0.7, 0.9] }),
    metric("retrieval.recall_at_5.snapshot", 0.6, "snapshot", { provenance: "judged", note: "judge precision 0.9" }),
  ]);
  const md = renderReport(r, compare(r, undefined));
  const snapshot = md.indexOf("## Corpus: snapshot");
  const synthetic = md.indexOf("## Corpus: synthetic");
  assert(snapshot !== -1 && synthetic > snapshot);
  assert(md.slice(snapshot, synthetic).includes("retrieval.recall_at_5.snapshot"));
  assert(!md.slice(snapshot, synthetic).includes("retrieval.recall_at_5.synthetic"));
  assertStringIncludes(md, "[0.7, 0.9]");
  assertStringIncludes(md, "No approved baseline: every metric is informational.");
  assertStringIncludes(md, "`judged`: involves a recorded judge");
  assert(!md.includes("`recorded_live`"), "only provenances in use are explained");
  assertStringIncludes(md, "- `retrieval.recall_at_5.snapshot`: judge precision 0.9");
  assertStringIncludes(md, "Cases: 1/2 ok.");
  assertStringIncludes(md, "- `q2`: expected a.ts | got b.ts");
  assertStringIncludes(md, "SQL symbol ranking is not exercised offline.");
  assert(md.endsWith("\n") && !md.endsWith("\n\n"));
});

Deno.test("report lists blocking changes and escapes table cells", () => {
  const base = approve(results([metric("a", 0.8, "synthetic", { label: "A | pipe" })]), undefined, {
    metrics: "all",
    reason: "r",
    allowRegression: false,
    ci: false,
    currentPins: { synthetic: "aaaaaaaaaaaaaaaa", snapshot: "bbbbbbbbbbbbbbbb" },
    date: "d",
    user: "u",
    gitSha: "s",
    gitDirty: false,
  }).baseline;
  const r = results([metric("a", 0.5, "synthetic", { label: "A | pipe" })]);
  const md = renderReport(r, compare(r, base));
  assertStringIncludes(md, "1 blocking change(s):");
  assertStringIncludes(md, "- `a`: regression (0.8 to 0.5)");
  assertStringIncludes(md, "A \\| pipe");
  assertStringIncludes(md, "| `a` | synthetic | 0.8 | 0.5 | -0.3 | 10 | regression | yes |");
});

Deno.test("renderComparison can be scoped to the metrics being approved", () => {
  const r = results([metric("a", 0.5, "synthetic"), metric("b", 0.5, "synthetic")]);
  const text = renderComparison(compare(r, undefined), { onlyIds: ["b"] });
  assert(text.includes("`b`") && !text.includes("`a`"));
});

Deno.test("report is byte-identical for equal results", () => {
  const make = () => results([metric("a", 1 / 3, "synthetic", { ci: [0.1, 0.5] })]);
  assertEquals(renderReport(make(), compare(make(), undefined)), renderReport(make(), compare(make(), undefined)));
});
