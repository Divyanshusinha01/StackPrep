import { assert, assertEquals } from "@std/assert";
import type { InterviewReport } from "@stackprep/shared";
import type { AnswerEvaluation } from "../../../../supabase/functions/interviews/tools/evaluate-answer.ts";
import { createFakeAIProvider, type FakeAIProvider } from "../../../../supabase/functions/_shared/testing.ts";
import { createFileRecorder } from "../../../core/recording.ts";
import type { SuiteResult } from "../../../core/types.ts";
import { CONFIG } from "../project.ts";
import { CONFLICT_SCHEMA_NAME, DISCLOSURE_SCHEMA_NAME } from "../src/conflict-judge.ts";
import { type IndexedCorpus, loadIndexedCorpus } from "../src/corpus.ts";
import { loadCorpus, SNAPSHOT, SYNTHETIC } from "../src/corpus-source.ts";
import { loadSessions, sessionsPinId } from "../src/sessions.ts";
import {
  conflictCalibrationItems,
  type ContradictionCase,
  type ContradictionDataset,
  contradictionPinId,
  contradictionSuite,
  EVALUATION_SITE,
  loadContradiction,
  REPORT_SITE,
  validateContradiction,
} from "./contradiction.ts";
import { passThrough, projectDir, runEnv, suiteContext } from "./testing.ts";

let cached: Promise<IndexedCorpus> | undefined;
const synthetic = () => (cached ??= loadIndexedCorpus(projectDir, SYNTHETIC));
const dataset = async () => {
  const corpus = await synthetic();
  return loadContradiction(projectDir, corpus, await loadSessions(projectDir, corpus));
};

const metric = (result: SuiteResult, id: string) => result.metrics.find((m) => m.id === `contradiction.synthetic.${id}`);
const value = (result: SuiteResult, id: string) => metric(result, id)?.value;

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "evals-contradiction-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

interface Script {
  /** identify: one note states claim, code fact and conflict; location_only: the note only names the file. */
  report?: "identify" | "location_only";
  /** The focus cue given to the interviewer for seeded cases. */
  focus?: "neutral" | "disclose";
  /** Flag every truthful control too. */
  flagControls?: boolean;
  /** Flag seeded cases with a detail that names neither location nor code fact. */
  vagueDetail?: boolean;
  /** The conflict judge says "identified" to everything. */
  blindConflictJudge?: boolean;
}

/** A scripted evaluator, report writer and judges; the judges agree with every human label. */
async function scriptedModel(script: Script = {}): Promise<FakeAIProvider> {
  const data = await dataset();
  const bySummary = new Map(data.cases.map((c) => [c.answer_summary, c]));
  const identifying = (c: ContradictionCase) => c.calibration!.find((l) => l.identifies)!.text;
  const cue = (c: ContradictionCase, discloses: boolean) => data.disclosure_calibration.find((d) => d.case === c.id && d.discloses === discloses)!.cue;
  const conflictLabels = new Map(conflictCalibrationItems(data).map((i) => [i.text, i.identifies]));
  const cueLabels = new Map(data.disclosure_calibration.map((d) => [d.cue, d.discloses]));
  return createFakeAIProvider((request) => {
    switch (request.schemaName) {
      case "answer_evaluation": {
        const c = bySummary.get(request.input.match(/<answer_summary>\n([\s\S]*?)\n<\/answer_summary>/)![1])!;
        const seeded = c.kind === "seeded";
        const flagged = seeded || script.flagControls === true;
        const evaluation: AnswerEvaluation = {
          area_id: "security",
          score: seeded ? 2 : 4,
          rating: seeded ? "weak" : "proficient",
          strengths: [],
          gaps: [],
          repo_evidence: [c.rubric.code.path],
          discrepancy: flagged,
          discrepancy_detail: !flagged ? "" : seeded && !script.vagueDetail ? identifying(c) : "The answer does not match the repository.",
          area_status: "partial",
          guidance: "follow_up",
          focus: seeded ? cue(c, script.focus === "disclose") : "",
        };
        return evaluation;
      }
      case "interview_report": {
        const c = data.cases.find((x) => request.input.includes(`Candidate: ${x.answer}`))!;
        const report: InterviewReport = {
          executive_summary: "The candidate answered one question about their repository.",
          categories: [{ name: "Security", rating: "developing", narrative: "One answer was discussed." }],
          strengths: [],
          gaps: [],
          interview_evidence: [],
          repository_evidence: [{ path: c.rubric.code.path, note: script.report === "location_only" ? "Discussed during the interview." : identifying(c) }],
          areas_to_improve: [],
          struggled_questions: [],
        };
        return report;
      }
      case CONFLICT_SCHEMA_NAME: {
        const notes = [...request.input.matchAll(/^\d+\. \[.*?\] (.*)$/gm)].map((m) => m[1]);
        const hit = script.blindConflictJudge ? 0 : notes.findIndex((n) => conflictLabels.get(n) === true);
        return { verdict: hit >= 0 ? "identified" : "not_identified", note: hit + 1, reason: "scripted" };
      }
      case DISCLOSURE_SCHEMA_NAME: {
        const text = request.input.match(/<cue>\n([\s\S]*?)\n<\/cue>/)![1];
        return { verdict: cueLabels.get(text) ? "discloses" : "neutral", reason: "scripted" };
      }
      default:
        return new Error(`unexpected request ${request.schemaName}`);
    }
  });
}

async function run(script: Script = {}): Promise<SuiteResult> {
  const corpus = await synthetic();
  return await contradictionSuite(SYNTHETIC, { gate: true }).run(suiteContext(corpus, await scriptedModel(script)), runEnv(passThrough));
}

Deno.test("the dataset seeds every planted flaw and every truthful control of the synthetic corpus, with enough labels to calibrate both judges", async () => {
  const data = await dataset();
  const manifest = (await loadCorpus(new URL("corpora/synthetic/", projectDir))).manifest as unknown as {
    planted_flaws: Array<{ id: string; path: string }>;
    truthful_controls: Array<{ id: string; path: string }>;
  };
  const ids = (kind: string) => data.cases.filter((c) => c.kind === kind).map((c) => `${c.id} ${c.rubric.code.path}`).sort();
  assertEquals(ids("seeded"), manifest.planted_flaws.map((f) => `${f.id} ${f.path}`).sort());
  assertEquals(ids("control"), manifest.truthful_controls.map((f) => `${f.id} ${f.path}`).sort());
  assertEquals([ids("seeded").length, ids("control").length], [15, 8]);
  assert(conflictCalibrationItems(data).length >= CONFIG.contradiction.floor.n);
  assert(data.disclosure_calibration.length >= CONFIG.contradiction.floor.n);
  for (const labels of [conflictCalibrationItems(data).map((i) => i.identifies), data.disclosure_calibration.map((d) => d.discloses)]) {
    assert(labels.filter(Boolean).length >= CONFIG.contradiction.floor.n / 3 && labels.filter((x) => !x).length >= CONFIG.contradiction.floor.n / 3);
  }
});

Deno.test("validation rejects rubrics that disagree with the code or cannot tell claim and code apart", async () => {
  const corpus = await synthetic();
  const sessions = await loadSessions(projectDir, corpus);
  const data = await dataset();
  const edit = (fn: (d: ContradictionDataset) => void) => {
    const copy = structuredClone(data);
    fn(copy);
    return validateContradiction(copy, corpus, sessions);
  };
  assertEquals(validateContradiction(data, corpus, sessions), []);
  const seeded = (d: ContradictionDataset) => d.cases.find((c) => c.id === "weak-password-hash")!;
  assert(edit((d) => (seeded(d).rubric.code.anchors = [{ pattern: "bcrypt", present: true }])).some((p) => p.includes("code anchors fail on src/auth/password.ts:6-8")));
  assert(edit((d) => (seeded(d).answer = "hashPassword uses bcrypt over SHA-256.")).some((p) => p.includes("matches a code mention")));
  assert(edit((d) => (seeded(d).calibration![0].text = "The candidate said bcrypt, but the code uses SHA-256.")).some((p) => p.includes("fails the location-and-mentions check")));
  assert(edit((d) => (seeded(d).rubric.code.symbol = "hashToken")).some((p) => p.includes('symbol "hashToken" is not in src/auth/password.ts')));
  assert(edit((d) => (d.disclosure_calibration[0].cue = "Point out the hashing is incorrect.")).some((p) => p.includes("labelled neutral but trips")));
  assert(edit((d) => (seeded(d).evidence = [])).some((p) => p.includes("evidence must include the rubric path")));
});

Deno.test("an accurate pipeline detects every seeded case, flags no control, identifies each conflict and discloses nothing", async () => {
  const result = await run();
  assertEquals(value(result, "evaluation.detection"), 1);
  assertEquals(value(result, "evaluation.flag_rate"), 1);
  assertEquals(value(result, "evaluation.false_positive_rate"), 0);
  assertEquals(value(result, "report.location_cited"), 1);
  assertEquals(value(result, "report.conflict_anchored"), 1);
  assertEquals(value(result, "report.conflict_identified"), 1);
  assertEquals(value(result, "interviewer.non_disclosure"), 1);
  assertEquals(value(result, "interviewer.non_disclosure.patterns"), 1);

  const detection = metric(result, "evaluation.detection")!;
  assertEquals([detection.n, detection.provenance, detection.gate], [15, "recorded_live", true]);
  assertEquals([metric(result, "evaluation.false_positive_rate")!.n, metric(result, "evaluation.false_positive_rate")!.direction], [8, "lower_is_better"]);
  // Both judges match every label, so they meet the floor and their judged metrics may gate.
  const identified = metric(result, "report.conflict_identified")!;
  assertEquals([identified.provenance, identified.gate], ["judged", true]);
  assert(identified.note?.includes("conflict judge precision 1.00, recall 1.00"));
  assertEquals(metric(result, "interviewer.non_disclosure")!.gate, true);
  assertEquals(value(result, "judge.conflict.recall"), 1);
  assertEquals(value(result, "judge.disclosure.precision"), 1);
  assert(!result.caveats?.some((c) => c.includes("below the floor")));
  assert(result.cases?.every((c) => c.ok), result.cases?.filter((c) => !c.ok).map((c) => c.id).join(", "));
  assert(result.metrics.every((m) => m.id.startsWith("contradiction.synthetic.") && m.corpus === SYNTHETIC));
});

Deno.test("the report model never receives discrepancy_detail, which is reported as a finding", async () => {
  const result = await run();
  const fed = metric(result, "report.detail_in_input")!;
  assertEquals([fed.value, fed.n, fed.gate], [0, 15, false]);
  assert(result.caveats?.some((c) => c.startsWith("Finding (not fixed here): discrepancy_detail reached the report model for none of 15")));
});

Deno.test("a report that only lists the conflicting path scores location cited, not conflict identified", async () => {
  const result = await run({ report: "location_only" });
  assertEquals(value(result, "report.location_cited"), 1);
  assertEquals(value(result, "report.conflict_anchored"), 0);
  assertEquals(value(result, "report.conflict_identified"), 0);
  assert(result.cases?.some((c) => c.id === "seeded/weak-password-hash" && !c.ok && c.detail?.includes("report: location cited")));
});

Deno.test("a flag whose detail names neither location nor code fact is not a detection", async () => {
  const result = await run({ vagueDetail: true });
  assertEquals(value(result, "evaluation.flag_rate"), 1);
  assertEquals(value(result, "evaluation.detection"), 0);
});

Deno.test("flagged controls raise the false-positive rate", async () => {
  const result = await run({ flagControls: true });
  assertEquals(value(result, "evaluation.false_positive_rate"), 1);
  assert(result.cases?.filter((c) => c.id.startsWith("control/")).every((c) => !c.ok));
});

Deno.test("a focus cue that reveals the discrepancy fails non-disclosure", async () => {
  const result = await run({ focus: "disclose" });
  assertEquals(value(result, "interviewer.non_disclosure"), 0);
  assert(value(result, "interviewer.non_disclosure.patterns")! < 1);
  assertEquals(value(result, "evaluation.detection"), 1);
});

Deno.test("below the floor, judged contradiction metrics are informational and say why", async () => {
  const result = await run({ blindConflictJudge: true });
  assertEquals(value(result, "judge.conflict.precision"), 0.5);
  assertEquals(metric(result, "report.conflict_identified")!.gate, false);
  assertEquals(metric(result, "interviewer.non_disclosure")!.gate, true);
  assert(result.caveats?.some((c) => c.startsWith("The conflict judge is below the floor")));
});

Deno.test("recorded once, the suite replays identically with no provider; recordings ignore dataset pins", async () => {
  const corpus = await synthetic();
  const pins = { [SYNTHETIC]: "c0rpus", [sessionsPinId(SYNTHETIC)]: "5essions", [contradictionPinId(SYNTHETIC)]: "c0ntradiction" };
  await withDir(async (dir) => {
    const live = await scriptedModel();
    const recorded = await contradictionSuite(SYNTHETIC, { gate: true }).run(
      suiteContext(corpus, live),
      runEnv(createFileRecorder({ dir, mode: "record", pins }), "record"),
    );
    // 23 evaluations, 15 reports, 30 + 30 calibration judgements and 15 conflict judgements. The scripted focus
    // cues are the neutral calibration cues, so their disclosure judgements are the same recordings.
    const calls = (name: string) => live.calls.filter((c) => c.schemaName === name).length;
    assertEquals([calls("answer_evaluation"), calls("interview_report"), calls(CONFLICT_SCHEMA_NAME), calls(DISCLOSURE_SCHEMA_NAME)], [23, 15, 45, 30]);
    assertEquals([...Deno.readDirSync(`${dir}/${EVALUATION_SITE}`)].length, 23);
    assertEquals([...Deno.readDirSync(`${dir}/${REPORT_SITE}`)].length, 15);

    const replay = createFileRecorder({ dir, mode: "replay", pins });
    const replayed = await contradictionSuite(SYNTHETIC, { gate: true }).run(suiteContext(corpus), runEnv(replay, "replay"));
    assertEquals(replay.stats().misses, []);
    assertEquals(JSON.stringify(replayed), JSON.stringify(recorded));

    const relabelled = createFileRecorder({ dir, mode: "replay", pins: { ...pins, [contradictionPinId(SYNTHETIC)]: "r3labelled" } });
    await contradictionSuite(SYNTHETIC, { gate: true }).run(suiteContext(corpus), runEnv(relabelled, "replay"));
    assertEquals(relabelled.stats().misses, []);
  });
});

Deno.test("without recordings, contradiction reports what was not measured", async () => {
  const corpus = await synthetic();
  await withDir(async (dir) => {
    const pins = { [SYNTHETIC]: "c0rpus", [sessionsPinId(SYNTHETIC)]: "5essions", [contradictionPinId(SYNTHETIC)]: "c0ntradiction" };
    const result = await contradictionSuite(SYNTHETIC, { gate: true }).run(suiteContext(corpus), runEnv(createFileRecorder({ dir, mode: "replay", pins }), "replay"));
    assertEquals(result.metrics, []);
    assert(result.caveats?.some((c) => c.startsWith("contradiction detection not measured for synthetic")));
    assert(result.caveats?.includes('judge not measured for 60 item(s): judgements are not recorded; run "eval record" with OPENAI_API_KEY.'));
    assert(result.cases?.filter((c) => c.id.startsWith("seeded/") || c.id.startsWith("control/")).every((c) => !c.ok && c.detail?.includes("not_recorded")));
  });
});

Deno.test("the contradiction suite runs on the synthetic corpus only, with its own pins", () => {
  const suite = contradictionSuite(SYNTHETIC, { gate: true });
  assertEquals(suite.id, "contradiction-synthetic");
  assertEquals(suite.pins, [SYNTHETIC, sessionsPinId(SYNTHETIC), contradictionPinId(SYNTHETIC)]);
  assert(!contradictionSuite(SNAPSHOT, { gate: false }).pins.includes(contradictionPinId(SYNTHETIC)));
});
