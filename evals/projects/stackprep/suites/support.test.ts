import { assert, assertEquals } from "@std/assert";
import { createFileRecorder } from "../../../core/recording.ts";
import type { SuiteResult } from "../../../core/types.ts";
import { CONFIG } from "../project.ts";
import { CALIBRATION_KINDS, claimPairs, type ClaimsDataset, claimsPinId, loadClaims, resolveClaims, spanCitation } from "../src/claims.ts";
import { type IndexedCorpus, loadIndexedCorpus } from "../src/corpus.ts";
import { SNAPSHOT, SYNTHETIC } from "../src/corpus-source.ts";
import { pipelineRun, sessionsPinId } from "../src/sessions.ts";
import { pipelineUnits } from "../src/surfaces.ts";
import { citationsSuite } from "./citations.ts";
import { type Judged, supportResult, supportSuite } from "./support.ts";
import { accurateJudge, passThrough, projectDir, runEnv, scriptedModel, suiteContext, WRONG_CLAIM } from "./testing.ts";

const cache = new Map<string, Promise<IndexedCorpus>>();
const indexed = (id: string) => {
  if (!cache.has(id)) cache.set(id, loadIndexedCorpus(projectDir, id));
  return cache.get(id)!;
};

const value = (result: SuiteResult, id: string) => result.metrics.find((m) => m.id === id)?.value;

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "evals-support-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** Both text suites over one context, as the project runs them. */
async function runBoth(corpus: IndexedCorpus, script: Parameters<typeof scriptedModel>[1], judge = accurateJudge) {
  const ctx = suiteContext(corpus, await scriptedModel(corpus, script, judge));
  const citations = await citationsSuite(SYNTHETIC, { gate: true }).run(ctx, runEnv(passThrough));
  const support = await supportSuite(SYNTHETIC, { gate: true }).run(ctx, runEnv(passThrough));
  return { citations, support };
}

Deno.test("both claims datasets are valid, with wrong claims on real paths and invented behaviour of real symbols", async () => {
  const synthetic = await loadClaims(projectDir, await indexed(SYNTHETIC));
  const snapshot = await loadClaims(projectDir, await indexed(SNAPSHOT));
  assert(synthetic.calibration.length >= 40, `${synthetic.calibration.length} synthetic calibration pairs`);
  assert(snapshot.calibration.length >= 12, `${snapshot.calibration.length} snapshot calibration pairs`);
  for (const claims of [synthetic, snapshot]) {
    for (const kind of CALIBRATION_KINDS) assert(claims.calibration.filter((p) => p.kind === kind).length >= 2, `${claims.dataset.corpus}: ${kind}`);
    assertEquals(new Set(claims.calibration.map((p) => p.key)).size, claims.calibration.length);
  }
  assert(synthetic.calibration.filter((p) => !p.supported).length >= CONFIG.support.floor.n / 3, "too few unsupported pairs to measure recall");
});

Deno.test("resolveClaims rejects labels whose anchors, key or kind disagree with the code", async () => {
  const corpus = await indexed(SYNTHETIC);
  const base: ClaimsDataset = { format: 1, corpus: SYNTHETIC, guidelines: [], calibration: [], labels: [] };
  const pair = {
    id: "p",
    kind: "supported" as const,
    claim: "verifyPassword compares in constant time.",
    citation: "src/auth/password.ts:10-14",
    supported: true,
    anchors: [{ pattern: "timingSafeEqual", present: true }],
  };
  assertEquals((await resolveClaims({ ...base, calibration: [pair] }, corpus)).problems, []);
  const flipped = await resolveClaims({ ...base, calibration: [{ ...pair, kind: "wrong_claim", supported: false }] }, corpus);
  assert(flipped.problems.some((p) => p.includes("anchors hold on src/auth/password.ts:10-14")));
  const mismatched = await resolveClaims({ ...base, calibration: [{ ...pair, supported: false }] }, corpus);
  assert(mismatched.problems.some((p) => p.includes("disagrees with supported=false")));
  const stale = await resolveClaims({
    ...base,
    labels: [{ key: "0000000000000000", claim: pair.claim, citation: "src/auth/password.ts:10-14", supported: true, anchors: pair.anchors }],
  }, corpus);
  assert(stale.problems.some((p) => p.includes("copy both from the unlabelled-pair listing")));
});

Deno.test("a valid path with a wrong claim lowers claim support and leaves citation validity at 100%", async () => {
  const corpus = await indexed(SYNTHETIC);
  const right = await runBoth(corpus, {});
  const wrong = await runBoth(corpus, { wrongClaim: true });
  assertEquals(value(right.citations, "citations.synthetic.validity"), 1);
  assertEquals(value(wrong.citations, "citations.synthetic.validity"), 1);
  assertEquals(value(right.support, "support.synthetic.claim_support.judge"), 1);
  const lowered = value(wrong.support, "support.synthetic.claim_support.judge")!;
  assert(lowered < 1, `support ${lowered}`);
  assert(value(wrong.support, "support.synthetic.claim_support.judge.evaluation")! < 1);
  assert(wrong.support.caveats?.some((c) => c.startsWith("Validity versus support: 100% of")));

  // The judge matches every calibration label, so it meets the floor and its support metric may gate.
  assertEquals(value(wrong.support, "support.synthetic.judge.precision"), 1);
  assertEquals(value(wrong.support, "support.synthetic.judge.recall"), 1);
  const judged = wrong.support.metrics.find((m) => m.id === "support.synthetic.claim_support.judge")!;
  assertEquals([judged.provenance, judged.gate], ["judged", true]);
  assert(judged.note?.includes("judge precision 1.00, recall 1.00"));
  assert(!wrong.support.caveats?.some((c) => c.includes("below the floor")));
  assert(wrong.support.metrics.every((m) => m.id.startsWith("support.synthetic.")));
});

Deno.test("below the floor, judged support is informational and says why", async () => {
  const corpus = await indexed(SYNTHETIC);
  const { support } = await runBoth(corpus, { wrongClaim: true }, () => "supported");
  assertEquals(value(support, "support.synthetic.judge.recall"), 0);
  const judged = support.metrics.find((m) => m.id === "support.synthetic.claim_support.judge")!;
  assertEquals(judged.gate, false);
  assert(support.caveats?.some((c) => c.includes("below the floor") && c.includes("judged support is informational")));
  assert(support.cases?.some((c) => c.id === "calibration/pw-bcrypt" && !c.ok));
});

Deno.test("unlabelled pairs are listed, never guessed; a label adds the anchor metric", async () => {
  const corpus = await indexed(SYNTHETIC);
  const live = await scriptedModel(corpus, { wrongClaim: true });
  const ctx = suiteContext(corpus, live);
  const result = await supportSuite(SYNTHETIC, { gate: true }).run(ctx, runEnv(passThrough));
  const pairCases = (result.cases ?? []).filter((c) => c.id.startsWith("pair/"));
  assert(pairCases.length > 0 && pairCases.every((c) => c.detail?.includes("UNLABELLED")));
  assertEquals(value(result, "support.synthetic.labelled_coverage"), 0);
  assert(!result.metrics.some((m) => m.id === "support.synthetic.claim_support.anchors"));
  assert(result.caveats?.some((c) => c.includes("have no human label")));

  // Label the wrong pair exactly as the listing shows it.
  const claims = await loadClaims(projectDir, corpus);
  const { pairs } = await claimPairs(pipelineUnits(await pipelineRun(ctx, SYNTHETIC, runEnv(passThrough))), corpus);
  const wrong = pairs.find((p) => p.claim === WRONG_CLAIM)!;
  assert(pairCases.some((c) => c.id === `pair/${wrong.key}` && c.detail?.includes(`citation "${spanCitation(wrong.span)}"`)));
  const label = { key: wrong.key, claim: wrong.claim, citation: spanCitation(wrong.span), supported: false, anchors: [{ pattern: "idempoten", flags: "i", present: true }] };
  const { resolved, problems } = await resolveClaims({ ...claims.dataset, labels: [label] }, corpus);
  assertEquals(problems, []);
  const verdict = (claim: string, calibrated?: boolean): Judged => ({ verdict: { verdict: accurateJudge(claim, calibrated), reason: "" } });
  const labelled = supportResult({
    corpusId: SYNTHETIC,
    claims: resolved!,
    pairs,
    calibrationVerdicts: resolved!.calibration.map((p) => verdict(p.claim, p.supported)),
    pairVerdicts: pairs.map((p) => verdict(p.claim)),
    claimCitations: pairs.length,
    validClaimCitations: pairs.length,
    moduleCitations: 0,
    problems: [],
    partial: false,
    floor: CONFIG.support.floor,
    seed: 1,
    gate: true,
  });
  const anchors = labelled.metrics.find((m) => m.id === "support.synthetic.claim_support.anchors")!;
  assertEquals([anchors.value, anchors.n, anchors.provenance, anchors.gate], [0, 1, "deterministic", true]);
  assert(labelled.cases?.some((c) => c.id === `pair/${wrong.key}` && !c.ok && c.detail?.includes("label supported=false")));
});

Deno.test("recorded once, both suites replay identically with no provider; judge keys ignore sessions", async () => {
  const corpus = await indexed(SYNTHETIC);
  const pins = { [SYNTHETIC]: "c0rpus", [sessionsPinId(SYNTHETIC)]: "5essions", [claimsPinId(SYNTHETIC)]: "c1aims" };
  await withDir(async (dir) => {
    const live = await scriptedModel(corpus, { wrongClaim: true });
    const record = createFileRecorder({ dir, mode: "record", pins });
    const recordCtx = suiteContext(corpus, live);
    const recorded = [
      await citationsSuite(SYNTHETIC, { gate: true }).run(recordCtx, runEnv(record, "record")),
      await supportSuite(SYNTHETIC, { gate: true }).run(recordCtx, runEnv(record, "record")),
    ];
    // One pipeline run serves both suites.
    assertEquals(live.calls.filter((c) => c.schemaName === "answer_evaluation").length, 12);

    const replay = createFileRecorder({ dir, mode: "replay", pins });
    const replayCtx = suiteContext(corpus);
    const replayed = [
      await citationsSuite(SYNTHETIC, { gate: true }).run(replayCtx, runEnv(replay, "replay")),
      await supportSuite(SYNTHETIC, { gate: true }).run(replayCtx, runEnv(replay, "replay")),
    ];
    assertEquals(replay.stats().misses, []);
    assertEquals(JSON.stringify(replayed), JSON.stringify(recorded));

    // A sessions edit invalidates the pipeline recordings but not the judgements.
    const edited = createFileRecorder({ dir, mode: "replay", pins: { ...pins, [sessionsPinId(SYNTHETIC)]: "ed1ted" } });
    const support = await supportSuite(SYNTHETIC, { gate: true }).run(suiteContext(corpus), runEnv(edited, "replay"));
    assert(support.metrics.some((m) => m.id === "support.synthetic.judge.recall"));
    assert(edited.stats().misses.every((m) => m.site !== "claim_support_judgement"));
  });
});

Deno.test("without recordings, support reports what was not measured", async () => {
  const corpus = await indexed(SYNTHETIC);
  await withDir(async (dir) => {
    const pins = { [SYNTHETIC]: "c0rpus", [sessionsPinId(SYNTHETIC)]: "5essions", [claimsPinId(SYNTHETIC)]: "c1aims" };
    const recorder = createFileRecorder({ dir, mode: "replay", pins });
    const result = await supportSuite(SYNTHETIC, { gate: true }).run(suiteContext(corpus), runEnv(recorder, "replay"));
    assertEquals(result.metrics, []);
    assert(result.caveats?.some((c) => c.startsWith("claim support not measured")));
    const calibration = (await loadClaims(projectDir, corpus)).calibration.length;
    assert(result.caveats?.includes(`judge not measured for ${calibration} pair(s): judgements are not recorded; run "eval record" with OPENAI_API_KEY.`));
  });
});

Deno.test("support suite ids and pins are separate per corpus", () => {
  const synthetic = supportSuite(SYNTHETIC, { gate: true });
  const snapshot = supportSuite(SNAPSHOT, { gate: false });
  assertEquals([synthetic.id, snapshot.id], ["support-synthetic", "support-stackprep-snapshot"]);
  assertEquals(snapshot.pins, [SNAPSHOT, sessionsPinId(SNAPSHOT), claimsPinId(SNAPSHOT)]);
});
