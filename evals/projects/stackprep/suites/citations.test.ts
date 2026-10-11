import { assert, assertEquals } from "@std/assert";
import { createFileRecorder } from "../../../core/recording.ts";
import type { SuiteResult } from "../../../core/types.ts";
import { claimsPinId } from "../src/claims.ts";
import { type IndexedCorpus, loadIndexedCorpus } from "../src/corpus.ts";
import { SNAPSHOT, SYNTHETIC } from "../src/corpus-source.ts";
import { loadSessions, sessionsPinId } from "../src/sessions.ts";
import { citationsSuite } from "./citations.ts";
import { passThrough, projectDir, runEnv, scriptedModel, suiteContext } from "./testing.ts";

const cache = new Map<string, Promise<IndexedCorpus>>();
const indexed = (id: string) => {
  if (!cache.has(id)) cache.set(id, loadIndexedCorpus(projectDir, id));
  return cache.get(id)!;
};

const metric = (result: SuiteResult, id: string) => result.metrics.find((m) => m.id === `citations.synthetic.${id}`);

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "evals-citations-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("both sessions datasets are valid against their corpora", async () => {
  for (const id of [SYNTHETIC, SNAPSHOT]) {
    const dataset = await loadSessions(projectDir, await indexed(id));
    assert(dataset.sessions.length >= 3, id);
    assert(dataset.sessions.every((s) => s.turns.length >= 3), id);
  }
});

Deno.test("suite ids, pins and metric ids are separate per corpus", () => {
  const synthetic = citationsSuite(SYNTHETIC, { gate: true });
  const snapshot = citationsSuite(SNAPSHOT, { gate: false });
  assertEquals([synthetic.id, snapshot.id], ["citations-synthetic", "citations-stackprep-snapshot"]);
  assertEquals(synthetic.pins, [SYNTHETIC, sessionsPinId(SYNTHETIC)]);
  assert(!synthetic.pins.includes(claimsPinId(SYNTHETIC)), "editing claim labels must not invalidate citation results");
});

Deno.test("valid citations score 100% with deterministic metrics; only overall validity gates", async () => {
  const corpus = await indexed(SYNTHETIC);
  const live = await scriptedModel(corpus);
  const result = await citationsSuite(SYNTHETIC, { gate: true }).run(suiteContext(corpus, live), runEnv(passThrough));
  const ids = result.metrics.map((m) => m.id);
  assertEquals(new Set(ids).size, ids.length);
  assert(ids.every((id) => id.startsWith("citations.synthetic.")));
  assertEquals(result.metrics.filter((m) => m.gate).map((m) => m.id), ["citations.synthetic.validity"]);
  for (const id of ["validity", "validity.path", "validity.line_range", "validity.symbol", "validity.plan", "validity.evaluation", "validity.report"]) {
    assertEquals(metric(result, id)?.value, 1, id);
  }
  for (const m of result.metrics) {
    assertEquals([m.provenance, m.corpus], ["deterministic", SYNTHETIC]);
    assert(m.ci && m.ci[0] <= m.value + 1e-9 && m.value <= m.ci[1] + 1e-9, m.id);
  }
  // "Postgres" in repo_evidence names no location.
  const uncited = metric(result, "uncited_references")!;
  assert(uncited.value > 0 && uncited.direction === "lower_is_better");
  assertEquals(result.cases, []);
  assert(result.caveats?.some((c) => c.startsWith("groundReport removed 0 of 4 repository_evidence entries across 4 report(s)")));
});

Deno.test("invented paths: groundReport removes those in repository_evidence, the rest stay invalid", async () => {
  const corpus = await indexed(SYNTHETIC);
  const live = await scriptedModel(corpus, { inventedPaths: true });
  const result = await citationsSuite(SYNTHETIC, { gate: true }).run(suiteContext(corpus, live), runEnv(passThrough));
  const before = metric(result, "validity.report_ungrounded")!.value;
  const after = metric(result, "validity.report")!.value;
  assert(before < after && after < 1, `${before} -> ${after}`);
  assert(metric(result, "validity")!.value < 1);
  assert(result.caveats?.includes("groundReport removed 4 of 8 repository_evidence entries across 4 report(s); 4 of the removed entries cited paths that do not exist."));
  assert(result.caveats?.some((c) => c.includes("4 invalid citation(s) remain in the saved reports, 4 of them in other fields")));
  const invalid = (result.cases ?? []).filter((c) => c.id.startsWith("invalid/report/"));
  assertEquals(invalid.length, 4);
  assert(invalid.every((c) => c.detail?.includes("src/payments/refund.ts")));
});

Deno.test("without recordings, replay reports not measured, lists the misses and never calls a model", async () => {
  const corpus = await indexed(SYNTHETIC);
  await withDir(async (dir) => {
    const pins = { [SYNTHETIC]: "c0rpus", [sessionsPinId(SYNTHETIC)]: "5essions" };
    const recorder = createFileRecorder({ dir, mode: "replay", pins });
    const result = await citationsSuite(SYNTHETIC, { gate: true }).run(suiteContext(corpus), runEnv(recorder, "replay"));
    assertEquals(result.metrics, []);
    assert(result.caveats?.[0].startsWith("citation validity not measured"));
    const problems = (result.cases ?? []).map((c) => c.id);
    assert(problems.includes("pipeline/plan"));
    assert(problems.includes("pipeline/s1-security/q1"));
    assert(result.cases?.every((c) => !c.ok && c.detail?.includes("not_recorded")));
    assert(recorder.stats().misses.length >= 5);
  });
});
