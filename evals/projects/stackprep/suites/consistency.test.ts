import { assert, assertEquals, assertRejects } from "@std/assert";
import type { AnswerEvaluation } from "../../../../supabase/functions/interviews/tools/evaluate-answer.ts";
import { createFakeAIProvider, type FakeAIProvider } from "../../../../supabase/functions/_shared/testing.ts";
import { createFileRecorder } from "../../../core/recording.ts";
import type { Recorder, RunEnv, SuiteResult } from "../../../core/types.ts";
import { type IndexedCorpus, loadIndexedCorpus } from "../src/corpus.ts";
import { SNAPSHOT, SYNTHETIC } from "../src/corpus-source.ts";
import { loadSessions, sessionsPinId } from "../src/sessions.ts";
import {
  consistencyPinId,
  consistencySuite,
  consistencyValues,
  type Expected,
  loadConsistency,
  SAMPLE_SITE,
  SUMMARY_SITE,
} from "./consistency.ts";
import { projectDir, suiteContext } from "./testing.ts";

const K = 3;
const cache = new Map<string, Promise<IndexedCorpus>>();
const indexed = (id: string) => {
  if (!cache.has(id)) cache.set(id, loadIndexedCorpus(projectDir, id));
  return cache.get(id)!;
};

const env = (recorder: Recorder, mode: RunEnv["mode"]): RunEnv => ({ mode, recorder, seed: 1, samples: K, log: () => {} });
const metric = (result: SuiteResult, id: string) => result.metrics.find((m) => m.id === id);

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "evals-consistency-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** Strong answers score 4 or 5, weak ones 2, mixed 3; with `constant`, every answer scores 3. */
async function scriptedEvaluator(corpus: IndexedCorpus, constant = false): Promise<FakeAIProvider> {
  const sessions = await loadSessions(projectDir, corpus);
  const dataset = await loadConsistency(projectDir, sessions);
  const bySummary = new Map<string, Expected>();
  for (const t of dataset.transcripts) {
    const session = sessions.sessions.find((s) => s.id === t.session)!;
    bySummary.set(session.turns[t.turn - 1].answer_summary, t.expected);
  }
  const calls = new Map<string, number>();
  return createFakeAIProvider((request) => {
    if (request.schemaName !== "answer_evaluation") return new Error(`unexpected request ${request.schemaName}`);
    const summary = request.input.match(/<answer_summary>\n([\s\S]*?)\n<\/answer_summary>/)![1];
    const expected = bySummary.get(summary)!;
    const n = calls.get(summary) ?? 0;
    calls.set(summary, n + 1);
    const score = constant ? 3 : expected === "strong" ? (n % 2 === 0 ? 5 : 4) : expected === "weak" ? 2 : 3;
    const evaluation: AnswerEvaluation = {
      area_id: "security",
      score,
      rating: score === 5 ? "strong" : score === 4 ? "proficient" : score === 3 ? "developing" : "weak",
      strengths: [],
      gaps: [],
      repo_evidence: [],
      discrepancy: expected === "weak",
      discrepancy_detail: expected === "weak" ? "The answer contradicts the code." : "",
      area_status: "partial",
      guidance: "follow_up",
      focus: "",
    };
    return evaluation;
  });
}

const pins = { [SYNTHETIC]: "c0rpus", [sessionsPinId(SYNTHETIC)]: "5essions", [consistencyPinId(SYNTHETIC)]: "c0nsistency" };

Deno.test("both consistency datasets are valid and label strong and weak transcripts", async () => {
  for (const id of [SYNTHETIC, SNAPSHOT]) {
    const dataset = await loadConsistency(projectDir, await loadSessions(projectDir, await indexed(id)));
    assert(dataset.transcripts.length >= 9, `${id}: ${dataset.transcripts.length} transcripts`);
    for (const expected of ["strong", "weak"]) assert(dataset.transcripts.some((t) => t.expected === expected), `${id}: no ${expected}`);
  }
});

Deno.test("record captures K separate evaluateAnswer samples per transcript; metrics come from those samples", async () => {
  const corpus = await indexed(SYNTHETIC);
  const transcripts = (await loadConsistency(projectDir, await loadSessions(projectDir, corpus))).transcripts;
  await withDir(async (dir) => {
    const live = await scriptedEvaluator(corpus);
    const recorder = createFileRecorder({ dir, mode: "record", pins });
    const result = await consistencySuite(SYNTHETIC, { gate: true }).run(suiteContext(corpus, live), env(recorder, "record"));

    // K live calls per transcript; the second pass and the summary are served from the recordings.
    assertEquals(live.calls.length, transcripts.length * K);
    const files = [...Deno.readDirSync(`${dir}/${SAMPLE_SITE}`)].map((e) => JSON.parse(Deno.readTextFileSync(`${dir}/${SAMPLE_SITE}/${e.name}`)));
    assertEquals(files.length, transcripts.length * K);
    assertEquals(new Set(files.map((f) => f.sample)), new Set([0, 1, 2]));
    assert(files.every((f) => Object.keys(f.pins).sort().join() === [SYNTHETIC, sessionsPinId(SYNTHETIC)].sort().join()), "samples ignore the labels pin");
    assertEquals([...Deno.readDirSync(`${dir}/${SUMMARY_SITE}`)].length, 1);

    // Strong transcripts score {5, 4, 5}; weak and mixed are constant.
    const strong = transcripts.filter((t) => t.expected === "strong").length;
    const strongStd = Math.sqrt(1 / 3);
    const std = metric(result, "consistency.synthetic.model.score_std")!;
    assertEquals([std.provenance, std.direction, std.n, std.gate], ["recorded_live", "lower_is_better", transcripts.length, true]);
    assert(Math.abs(std.value - (strong * strongStd) / transcripts.length) < 1e-12);
    assert(std.note?.includes("gpt-6-luna (reasoning low), K=3, recorded "));
    assertEquals(metric(result, "consistency.synthetic.model.discrepancy_agreement")!.value, 1);
    assert(metric(result, "consistency.synthetic.model.rating_agreement")!.value < 1);
    assert(metric(result, "consistency.synthetic.model.score_separation")!.value > 2);
    const replay = metric(result, "consistency.synthetic.replay.reproducibility")!;
    assertEquals([replay.value, replay.provenance], [1, "replay_reproducibility"]);
    assert(result.metrics.every((m) => m.id.startsWith("consistency.synthetic.") && m.corpus === SYNTHETIC));
    assert(result.cases?.every((c) => c.ok));
  });
});

Deno.test("replay reproduces the exact samples with no provider and reports reproducibility separately", async () => {
  const corpus = await indexed(SYNTHETIC);
  await withDir(async (dir) => {
    const recorded = await consistencySuite(SYNTHETIC, { gate: true }).run(
      suiteContext(corpus, await scriptedEvaluator(corpus)),
      env(createFileRecorder({ dir, mode: "record", pins }), "record"),
    );
    const replay = createFileRecorder({ dir, mode: "replay", pins });
    const replayed = await consistencySuite(SYNTHETIC, { gate: true }).run(suiteContext(corpus), env(replay, "replay"));
    assertEquals(replay.stats().misses, []);
    assertEquals(JSON.stringify(replayed), JSON.stringify(recorded));

    // Relabelling transcripts keeps the samples but needs a new summary.
    const relabelled = createFileRecorder({ dir, mode: "replay", pins: { ...pins, [consistencyPinId(SYNTHETIC)]: "r3labelled" } });
    const result = await consistencySuite(SYNTHETIC, { gate: true }).run(suiteContext(corpus), env(relabelled, "replay"));
    assertEquals(relabelled.stats().misses.map((m) => m.site), [SUMMARY_SITE]);
    assert(metric(result, "consistency.synthetic.model.score_std"));
    assert(!metric(result, "consistency.synthetic.replay.reproducibility"));
    assert(result.caveats?.some((c) => c.includes("record-time summary is not recorded")));
  });
});

Deno.test("replay fails when recomputed values differ from those stored at record time", async () => {
  const corpus = await indexed(SYNTHETIC);
  await withDir(async (dir) => {
    await consistencySuite(SYNTHETIC, { gate: true }).run(
      suiteContext(corpus, await scriptedEvaluator(corpus)),
      env(createFileRecorder({ dir, mode: "record", pins }), "record"),
    );
    const [entry] = [...Deno.readDirSync(`${dir}/${SUMMARY_SITE}`)];
    const path = `${dir}/${SUMMARY_SITE}/${entry.name}`;
    const stored = JSON.parse(Deno.readTextFileSync(path));
    stored.output.values.scoreStd += 0.01;
    Deno.writeTextFileSync(path, JSON.stringify(stored));
    await assertRejects(
      () => consistencySuite(SYNTHETIC, { gate: true }).run(suiteContext(corpus), env(createFileRecorder({ dir, mode: "replay", pins }), "replay")),
      Error,
      "replay reproducibility failed: values recomputed from the stored samples differ from those stored at record time (scoreStd)",
    );
  });
});

Deno.test("constant output fails the strong-above-weak sanity check", async () => {
  const corpus = await indexed(SYNTHETIC);
  const constant = await scriptedEvaluator(corpus, true);
  await assertRejects(
    () => consistencySuite(SYNTHETIC, { gate: true }).run(suiteContext(corpus, constant), env({ call: (_r, p) => p() }, "live")),
    Error,
    "strong-above-weak sanity check failed",
  );
});

Deno.test("a live run reports model consistency but no replay reproducibility", async () => {
  const corpus = await indexed(SYNTHETIC);
  const live = await scriptedEvaluator(corpus);
  const result = await consistencySuite(SYNTHETIC, { gate: true }).run(suiteContext(corpus, live), env({ call: (_r, p) => p() }, "live"));
  assert(metric(result, "consistency.synthetic.model.score_std")!.note?.includes("live run, not recorded"));
  assert(!metric(result, "consistency.synthetic.replay.reproducibility"));
  assert(result.caveats?.some((c) => c.startsWith("replay reproducibility not checked: live run")));
});

Deno.test("without recordings, consistency reports what was not measured", async () => {
  const corpus = await indexed(SYNTHETIC);
  await withDir(async (dir) => {
    const recorder = createFileRecorder({ dir, mode: "replay", pins });
    const result = await consistencySuite(SYNTHETIC, { gate: true }).run(suiteContext(corpus), env(recorder, "replay"));
    assertEquals(result.metrics, []);
    assert(result.caveats?.some((c) => c.startsWith("model consistency not measured")));
    assert(result.cases?.every((c) => !c.ok && c.detail?.includes("not recorded")));
  });
});

Deno.test("consistencyValues excludes transcripts with fewer than two valid samples", () => {
  const sample = (score: number) => ({ score, rating: "weak", guidance: "clarify", discrepancy: false });
  const values = consistencyValues([
    { id: "a", expected: "strong", samples: [sample(4), sample(5), null], recorded: true },
    { id: "b", expected: "weak", samples: [sample(2), null, null], recorded: true },
  ], 3);
  assertEquals(values.measured, 1);
  assertEquals(values.validRate, 3 / 6);
  assertEquals(values.separation, null);
  assertEquals(values.scoreRange, 1);
});

Deno.test("consistency suite ids and pins are separate per corpus", () => {
  const synthetic = consistencySuite(SYNTHETIC, { gate: true });
  const snapshot = consistencySuite(SNAPSHOT, { gate: false });
  assertEquals([synthetic.id, snapshot.id], ["consistency-synthetic", "consistency-stackprep-snapshot"]);
  assertEquals(snapshot.pins, [SNAPSHOT, sessionsPinId(SNAPSHOT), consistencyPinId(SNAPSHOT)]);
});
