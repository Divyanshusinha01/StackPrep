/**
 * Contradiction detection on one corpus (PRD section 17). Each case is a one-turn interview in which the
 * candidate either contradicts the pinned code (seeded) or describes it truthfully (control), with a
 * human conflict rubric: the claim facet, the code facet at a path and symbol, and how they conflict.
 *
 * - Stage A, the real `evaluateAnswer`: seeded cases must be flagged with a `discrepancy_detail` that
 *   names the location and states the code fact (detection rate); controls must not be flagged
 *   (false-positive rate).
 * - Stage B, the real `runInterviewReport` over the same interview: tiers, of which only the last counts.
 *   "location cited": a note cites the rubric's file or symbol. "conflict identified": one note cites it
 *   and states both facets (deterministic mentions) and the calibrated judge agrees that it relates them.
 * - Stage C, non-disclosure: the `focus` cue the voice interviewer receives must not reveal the
 *   discrepancy (deterministic patterns plus the calibrated judge).
 *
 * Whether `discrepancy_detail` reaches the report model is measured too: `buildReportInput` passes only
 * the boolean, which is a finding reported here, not fixed.
 */
import type { InterviewPlanningOutput, InterviewReport } from "@stackprep/shared";
import { AIInvalidOutputError, type AIProvider, type StructuredRequest } from "../../../../supabase/functions/_shared/ai/provider.ts";
import { ReplayMissError } from "../../../core/recording.ts";
import { bootstrapCI } from "../../../core/stats.ts";
import type { Metric, PinSpec, Recorder, Suite, SuiteResult } from "../../../core/types.ts";
import { recordedAIProvider } from "../src/ai.ts";
import { type PipelineMemory, pipelineMemory } from "../src/analysis.ts";
import { type Anchor, anchorProblems, anchorsHold, type Citation, extractCitations, lineCount, resolveCitation } from "../src/citations.ts";
import {
  type BinaryCalibration,
  calibrateBinary,
  type ConflictSpec,
  type ConflictVerdict,
  type DisclosureVerdict,
  judgeConflict,
  judgeDisclosure,
  type JudgedNote,
} from "../src/conflict-judge.ts";
import type { IndexedCorpus } from "../src/corpus.ts";
import { evaluateTurn, evaluationToolContext, interviewStore } from "../src/evaluate.ts";
import type { JudgeFloor } from "../src/judge.ts";
import type { TaskModel } from "../src/planning.ts";
import { runReport } from "../src/report.ts";
import {
  evidenceThrough,
  loadSessions,
  type PipelineContext,
  scopedRecorder,
  type Session,
  SESSIONS_DATASET_FORMAT,
  type SessionsDataset,
  sessionsPinId,
  type SessionTurn,
  sessionMessages,
  validateSessions,
} from "../src/sessions.ts";
import { claimCitations, reportUnits } from "../src/surfaces.ts";

export const CONTRADICTION_DATASET_FORMAT = 1;
export const EVALUATION_SITE = "contradiction_evaluation";
export const REPORT_SITE = "contradiction_report";
/** Model calls in flight at once when recording. */
const CONCURRENCY = 6;

export const CASE_KINDS = ["seeded", "control"] as const;
export type CaseKind = typeof CASE_KINDS[number];

/** Wording that tells the interviewer, or the candidate through it, that the answer conflicts with the code. */
export const DISCLOSURE_PATTERNS: Anchor[] = [
  { pattern: String.raw`\b(contradict\w*|discrepan\w*|inconsisten\w*|mismatch\w*)`, flags: "i", present: true },
  { pattern: String.raw`\b(incorrect|mistaken|inaccurate|untrue)\b`, flags: "i", present: true },
  { pattern: String.raw`\b(is|was|are|were|got (it|that)) wrong\b`, flags: "i", present: true },
  { pattern: String.raw`\bdo(es)?(n't| not) match\b`, flags: "i", present: true },
  { pattern: String.raw`\b(point out|correct (them|the candidate)|tell (them|the candidate) (that|the code))\b`, flags: "i", present: true },
  { pattern: String.raw`\bthe code (actually|really|instead)\b`, flags: "i", present: true },
];

export interface ConflictRubric {
  claim: {
    facet: string;
    /** Text stating the claim; required for seeded cases. */
    mentions?: Anchor[];
  };
  code: {
    path: string;
    symbol: string;
    lines: [number, number];
    facet: string;
    /** Must hold on the pinned span, so the rubric breaks loudly when the code changes. */
    anchors: Anchor[];
    /** Text stating the code fact; required for seeded cases. */
    mentions?: Anchor[];
  };
  relation: string;
}

export interface ConflictLabel {
  text: string;
  identifies: boolean;
}

export interface ContradictionCase extends SessionTurn {
  id: string;
  kind: CaseKind;
  rubric: ConflictRubric;
  /** Human-labelled report notes for the conflict judge; seeded cases only. */
  calibration?: ConflictLabel[];
}

export interface DisclosureCue {
  case: string;
  cue: string;
  discloses: boolean;
}

export interface ContradictionDataset {
  format: number;
  corpus: string;
  guidelines: string[];
  cases: ContradictionCase[];
  disclosure_calibration: DisclosureCue[];
}

export const contradictionPath = (corpusId: string) => `datasets/contradiction/${corpusId}.json`;
export const contradictionPinId = (corpusId: string) => `dataset.contradiction.${corpusId}`;

export function contradictionDatasetPins(corpusIds: readonly string[]): PinSpec[] {
  return corpusIds.map((id) => ({ id: contradictionPinId(id), kind: "dataset", files: [contradictionPath(id)] }));
}

/** True when any anchor's pattern matches (mentions are alternatives, unlike code anchors). */
export function matchesAny(anchors: readonly Anchor[] | undefined, text: string): boolean {
  return (anchors ?? []).some((a) => new RegExp(a.pattern, a.flags ?? "").test(text));
}

function locates(corpus: IndexedCorpus, citations: readonly Citation[], path: string): boolean {
  return citations.some((c) => {
    const r = resolveCitation(corpus, c);
    return r.valid && r.file === path;
  });
}

/** One note cites the rubric's location and states both the claim and the code fact. */
export function noteIdentifies(corpus: IndexedCorpus, rubric: ConflictRubric, citations: readonly Citation[], text: string): boolean {
  return locates(corpus, citations, rubric.code.path) && matchesAny(rubric.claim.mentions, text) && matchesAny(rubric.code.mentions, text);
}

/** A discrepancy_detail names the location and states what the code does. */
export function detailIdentifies(corpus: IndexedCorpus, rubric: ConflictRubric, detail: string): boolean {
  return locates(corpus, extractCitations(detail, corpus.files.keys()), rubric.code.path) && matchesAny(rubric.code.mentions, detail);
}

/** A cue reveals the conflict when it uses disclosure wording or states the contradicting code fact. */
export function disclosedByPattern(rubric: ConflictRubric, cue: string): boolean {
  return matchesAny(DISCLOSURE_PATTERNS, cue) || matchesAny(rubric.code.mentions, cue);
}

export function conflictSpec(rubric: ConflictRubric): ConflictSpec {
  const { claim, code, relation } = rubric;
  return { claim: claim.facet, path: code.path, symbol: code.symbol, lines: code.lines, code: code.facet, relation };
}

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

function anchorListProblems(at: string, anchors: Anchor[] | undefined, what: string): string[] {
  if (!Array.isArray(anchors) || anchors.length === 0) return [`${at}: ${what} needs at least one anchor`];
  return anchorProblems(anchors).map((p) => `${at}: ${what}: ${p}`);
}

/** Problems that make a contradiction dataset unusable against this corpus and sessions state; empty when it is valid. */
export function validateContradiction(dataset: ContradictionDataset, corpus: IndexedCorpus, sessions: SessionsDataset): string[] {
  const problems: string[] = [];
  if (dataset.format !== CONTRADICTION_DATASET_FORMAT) problems.push(`format must be ${CONTRADICTION_DATASET_FORMAT}`);
  if (dataset.corpus !== corpus.id) problems.push(`dataset is for corpus "${dataset.corpus}", not "${corpus.id}"`);
  if (!Array.isArray(dataset.cases) || dataset.cases.length === 0) return [...problems, "no cases"];

  // Dialogue, ids and evidence are checked exactly as scripted sessions are.
  const asSessions: SessionsDataset = {
    format: SESSIONS_DATASET_FORMAT,
    corpus: corpus.id,
    guidelines: [],
    state: sessions.state,
    sessions: dataset.cases.map((c) => ({ id: c.id, description: c.kind, turns: [c] })),
  };
  problems.push(...validateSessions(asSessions, corpus).map((p) => p.replace(/^session /, "case ").replace(/ turn 1:/, ":")));

  const seeded = new Map<string, ContradictionCase>();
  for (const c of dataset.cases) {
    const at = `case ${c.id}`;
    if (!CASE_KINDS.includes(c.kind)) problems.push(`${at}: kind must be one of ${CASE_KINDS.join(", ")}`);
    const rubric = c.rubric;
    if (!rubric?.claim || !rubric.code) {
      problems.push(`${at}: rubric needs claim and code`);
      continue;
    }
    if (!nonEmpty(rubric.claim.facet) || !nonEmpty(rubric.code.facet) || !nonEmpty(rubric.relation)) problems.push(`${at}: rubric facets and relation must be non-empty`);
    const { path, symbol, lines } = rubric.code;
    const text = corpus.files.get(path);
    if (text === undefined) {
      problems.push(`${at}: rubric path "${path}" is not in the corpus`);
      continue;
    }
    if (!(c.evidence ?? []).some((e) => e.path === path)) problems.push(`${at}: evidence must include the rubric path ${path}`);
    if (!nonEmpty(symbol) || !resolveCitation(corpus, { raw: symbol, path, symbol }).valid) problems.push(`${at}: symbol "${symbol}" is not in ${path}`);
    if (!Array.isArray(lines) || !(lines[0] >= 1 && lines[0] <= lines[1] && lines[1] <= lineCount(text))) {
      problems.push(`${at}: rubric lines must lie inside ${path}`);
      continue;
    }
    const codeAnchors = anchorListProblems(at, rubric.code.anchors, "code anchors");
    problems.push(...codeAnchors);
    const span = text.split("\n").slice(lines[0] - 1, lines[1]).join("\n");
    if (codeAnchors.length === 0 && !anchorsHold(rubric.code.anchors, span)) {
      problems.push(`${at}: code anchors fail on ${path}:${lines[0]}-${lines[1]}; fix the rubric or the anchors`);
    }

    if (c.kind === "control") {
      if (c.calibration !== undefined) problems.push(`${at}: controls take no conflict calibration`);
      continue;
    }
    seeded.set(c.id, c);
    const mentionProblems = [
      ...anchorListProblems(at, rubric.claim.mentions, "claim mentions"),
      ...anchorListProblems(at, rubric.code.mentions, "code mentions"),
    ];
    problems.push(...mentionProblems);
    if (mentionProblems.length > 0) continue;
    if (!matchesAny(rubric.claim.mentions, c.answer)) problems.push(`${at}: the answer matches no claim mention`);
    if (matchesAny(rubric.code.mentions, c.answer)) problems.push(`${at}: the answer matches a code mention, so the mentions cannot tell claim and code apart`);
    const labels = Array.isArray(c.calibration) ? c.calibration : [];
    if (!labels.some((l) => l.identifies === true) || !labels.some((l) => l.identifies === false)) {
      problems.push(`${at}: calibration needs at least one identifying and one non-identifying note`);
    }
    labels.forEach((l, i) => {
      if (!nonEmpty(l.text) || typeof l.identifies !== "boolean") {
        problems.push(`${at}: calibration ${i + 1} needs text and identifies`);
      } else if (l.identifies && !noteIdentifies(corpus, rubric, extractCitations(l.text, corpus.files.keys()), l.text)) {
        problems.push(`${at}: calibration ${i + 1} is labelled identifying but fails the location-and-mentions check`);
      }
    });
  }

  if (!Array.isArray(dataset.disclosure_calibration)) return [...problems, "disclosure_calibration must be an array"];
  dataset.disclosure_calibration.forEach((d, i) => {
    const at = `disclosure_calibration ${i + 1}`;
    const c = seeded.get(d.case);
    if (!c) problems.push(`${at}: "${d.case}" is not a seeded case`);
    if (!nonEmpty(d.cue) || typeof d.discloses !== "boolean") {
      problems.push(`${at}: needs cue and discloses`);
    } else if (c && !d.discloses && disclosedByPattern(c.rubric, d.cue)) {
      problems.push(`${at}: labelled neutral but trips the disclosure patterns or the case's code mentions`);
    }
  });
  return problems;
}

export async function loadContradiction(projectDir: URL, corpus: IndexedCorpus, sessions: SessionsDataset): Promise<ContradictionDataset> {
  const path = contradictionPath(corpus.id);
  const dataset = JSON.parse(await Deno.readTextFile(new URL(path, projectDir))) as ContradictionDataset;
  const problems = validateContradiction(dataset, corpus, sessions);
  if (problems.length > 0) throw new Error(`${path}: ${problems.join("; ")}`);
  return dataset;
}

/** Conflict-judge calibration notes in dataset order. */
export function conflictCalibrationItems(dataset: ContradictionDataset): Array<ConflictLabel & { case: ContradictionCase }> {
  return dataset.cases.filter((c) => c.kind === "seeded").flatMap((c) => (c.calibration ?? []).map((l) => ({ ...l, case: c })));
}

export interface ContradictionSettings {
  judge: TaskModel;
  /** Below it, a judge's metrics are informational. */
  floor: JudgeFloor;
}

export interface ContradictionContext extends PipelineContext {
  contradiction: ContradictionSettings;
}

export interface ContradictionSuiteOptions {
  /** Whether the headline metrics may gate CI (judged ones only while their judge meets the floor). */
  gate: boolean;
}

export interface EvaluationOutcome {
  discrepancy: boolean;
  detail: string;
  guidance: string;
  focus: string;
  /** Deterministic: the detail names the location and states the code fact (seeded cases only). */
  identifies: boolean;
  /** Deterministic: the focus cue uses disclosure wording or states the code fact (seeded cases only). */
  disclosedByPattern: boolean;
}

export interface ReportNote extends JudgedNote {
  /** Deterministic: cites the location and states both facets. */
  anchored: boolean;
}

export interface ReportOutcome {
  /** Report notes that cite the rubric's location. */
  notes: ReportNote[];
  /** Whether the report model's input carried the evaluation's discrepancy_detail; null when nothing was flagged. */
  detailInInput: boolean | null;
}

export interface CaseRun {
  id: string;
  kind: CaseKind;
  evaluation: EvaluationOutcome | "not_recorded" | "failed";
  report: ReportOutcome | "not_recorded" | "failed" | "skipped";
}

export type Judged<T> = { verdict: T; missing?: undefined } | { verdict?: undefined; missing: "not_recorded" | "invalid_output" };

export function contradictionSuite(corpusId: string, options: ContradictionSuiteOptions): Suite<ContradictionContext> {
  return {
    id: `contradiction-${corpusId}`,
    pins: [corpusId, sessionsPinId(corpusId), contradictionPinId(corpusId)],
    run: async (ctx, env) => {
      const corpus = ctx.corpora.get(corpusId);
      if (!corpus) throw new Error(`corpus "${corpusId}" is not loaded`);
      const sessions = await loadSessions(ctx.projectDir, corpus);
      const dataset = await loadContradiction(ctx.projectDir, corpus, sessions);
      const memory = await pipelineMemory(corpus);
      // Keyed on the corpus only: every request carries its whole case, so editing a rubric or label never re-records outputs.
      const recorder = scopedRecorder(env.recorder, [corpusId]);
      env.log(`contradiction ${corpusId}: ${dataset.cases.length} cases`);
      const runs = await mapLimited(dataset.cases, (c, i) => runCase(ctx, corpus, memory, sessions.state, recorder, c, i));

      const judgeAI = recordedAIProvider(recorder, { provider: ctx.liveAI });
      const task = ctx.contradiction.judge;
      const byId = new Map(dataset.cases.map((c) => [c.id, c]));
      const conflictCalibration = await mapLimited(
        conflictCalibrationItems(dataset),
        (item) => judged(() => judgeConflict(judgeAI, task, conflictSpec(item.case.rubric), [{ field: "note", text: item.text }])),
      );
      const disclosureCalibration = await mapLimited(
        dataset.disclosure_calibration,
        (d) => judged(() => judgeDisclosure(judgeAI, task, conflictSpec(byId.get(d.case)!.rubric), d.cue)),
      );
      const conflictVerdicts = new Map<string, Judged<ConflictVerdict>>();
      const disclosureVerdicts = new Map<string, Judged<DisclosureVerdict>>();
      await mapLimited(runs.filter((r) => r.kind === "seeded"), async (r) => {
        const spec = conflictSpec(byId.get(r.id)!.rubric);
        if (typeof r.report === "object" && r.report.notes.length > 0) {
          const notes = r.report.notes.map(({ field, text, about }) => ({ field, text, ...(about ? { about } : {}) }));
          conflictVerdicts.set(r.id, await judged(() => judgeConflict(judgeAI, task, spec, notes)));
        }
        if (typeof r.evaluation === "object" && r.evaluation.focus.trim()) {
          disclosureVerdicts.set(r.id, await judged(() => judgeDisclosure(judgeAI, task, spec, (r.evaluation as EvaluationOutcome).focus)));
        }
      });

      return contradictionResult({
        corpusId,
        dataset,
        runs,
        conflictCalibration,
        disclosureCalibration,
        conflictVerdicts,
        disclosureVerdicts,
        models: { evaluation: ctx.pipeline.evaluation, report: ctx.pipeline.report },
        floor: ctx.contradiction.floor,
        seed: env.seed,
        gate: options.gate,
      });
    },
  };
}

async function judged<T>(fn: () => Promise<T>): Promise<Judged<T>> {
  try {
    return { verdict: await fn() };
  } catch (err) {
    if (err instanceof ReplayMissError) return { missing: "not_recorded" };
    if (err instanceof AIInvalidOutputError) return { missing: "invalid_output" };
    throw err;
  }
}

/** Evaluates the case's one answer from a fresh store, then (seeded cases) generates the report on that interview. */
async function runCase(
  ctx: ContradictionContext,
  corpus: IndexedCorpus,
  memory: PipelineMemory,
  state: InterviewPlanningOutput,
  recorder: Recorder,
  c: ContradictionCase,
  index: number,
): Promise<CaseRun> {
  const session: Session = { id: c.id, description: c.kind, turns: [c] };
  const messages = sessionMessages(session);
  const evidence = evidenceThrough(session, 0);
  const store = interviewStore(corpus, memory, state);
  const base = { id: c.id, kind: c.kind };

  let evaluation: CaseRun["evaluation"];
  try {
    const ai = recordedAIProvider(recorder, { provider: ctx.liveAI, site: EVALUATION_SITE });
    const turn = await evaluateTurn({ ...evaluationToolContext(corpus, store, ai, ctx.pipeline.evaluation), store }, messages, evidence, c.answer_summary);
    if (!turn) {
      evaluation = "failed";
    } else {
      const { discrepancy, discrepancy_detail: detail } = turn.record;
      const focus = turn.output.focus ?? "";
      const seeded = c.kind === "seeded";
      evaluation = {
        discrepancy,
        detail,
        guidance: turn.output.guidance,
        focus,
        identifies: seeded && discrepancy && detailIdentifies(corpus, c.rubric, detail),
        disclosedByPattern: seeded && focus.trim() !== "" && disclosedByPattern(c.rubric, focus),
      };
    }
  } catch (err) {
    if (err instanceof ReplayMissError) return { ...base, evaluation: "not_recorded", report: "skipped" };
    throw err;
  }
  if (c.kind === "control") return { ...base, evaluation, report: "skipped" };

  const inner = recordedAIProvider(recorder, { provider: ctx.liveAI, site: REPORT_SITE });
  const seen = { input: "", missed: false };
  const capturing: AIProvider = {
    async generateStructured<T>(request: StructuredRequest<T>) {
      seen.input = request.input;
      try {
        return await inner.generateStructured(request);
      } catch (err) {
        if (err instanceof ReplayMissError) seen.missed = true;
        throw err;
      }
    },
  };
  const coverage = (store.state?.coverageMap ?? state.coverage_map) as InterviewPlanningOutput["coverage_map"];
  try {
    const run = await runReport(corpus, memory, capturing, ctx.pipeline.report, { index: index + 1, messages, evaluations: store.evaluations, evidence, coverage });
    const flagged = typeof evaluation === "object" && evaluation.discrepancy && evaluation.detail ? evaluation.detail : null;
    return {
      ...base,
      evaluation,
      report: { notes: locatedNotes(corpus, c.rubric, run.grounded, c.id), detailInInput: flagged === null ? null : carries(seen.input, flagged) },
    };
  } catch {
    // Production maps every error to a fixed code, so a replay miss is known only from the tracker.
    return { ...base, evaluation, report: seen.missed ? "not_recorded" : "failed" };
  }
}

function carries(input: string, detail: string): boolean {
  return input.includes(detail) || input.includes(JSON.stringify(detail).slice(1, -1));
}

/** Notes of the saved report that cite the rubric's location, own or bound (a repository_evidence note to its path). */
function locatedNotes(corpus: IndexedCorpus, rubric: ConflictRubric, report: InterviewReport, at: string): ReportNote[] {
  const paths = [...corpus.files.keys()];
  return reportUnits("report", at, report).flatMap((unit) => {
    if (unit.role === "path") return [];
    const citations = claimCitations(unit, paths);
    if (!locates(corpus, citations, rubric.code.path)) return [];
    return [{
      field: unit.field,
      text: unit.text,
      ...(unit.bound ? { about: unit.bound.text } : {}),
      anchored: noteIdentifies(corpus, rubric, citations, unit.text),
    }];
  });
}

export interface ContradictionInput {
  corpusId: string;
  dataset: ContradictionDataset;
  runs: CaseRun[];
  /** Aligned with `conflictCalibrationItems(dataset)`. */
  conflictCalibration: Judged<ConflictVerdict>[];
  /** Aligned with `dataset.disclosure_calibration`. */
  disclosureCalibration: Judged<DisclosureVerdict>[];
  /** Per seeded case whose report cites the location. */
  conflictVerdicts: ReadonlyMap<string, Judged<ConflictVerdict>>;
  /** Per seeded case with a non-empty focus cue. */
  disclosureVerdicts: ReadonlyMap<string, Judged<DisclosureVerdict>>;
  models: { evaluation: TaskModel; report: TaskModel };
  floor: JudgeFloor;
  seed: number;
  gate: boolean;
}

const fmt = (x: number | null) => (x === null ? "n/a" : x.toFixed(2));
const modelName = (m: TaskModel) => `${m.model} (reasoning ${m.reasoningEffort ?? "default"})`;

/** Metrics, cases and caveats from the case runs and judge verdicts; pure, so tests can feed them directly. */
export function contradictionResult(input: ContradictionInput): SuiteResult {
  const { corpusId, dataset, runs, seed } = input;
  const metrics: Metric[] = [];
  const caveats: string[] = [];
  const rate = (id: string, label: string, values: number[], extra: Pick<Metric, "provenance" | "gate"> & Partial<Metric>) => {
    if (values.length === 0) return;
    metrics.push({
      id: `contradiction.${corpusId}.${id}`,
      label: `${label} (${corpusId})`,
      value: values.reduce((a, b) => a + b, 0) / values.length,
      n: values.length,
      ci: bootstrapCI(values, { seed }),
      direction: "higher_is_better",
      corpus: corpusId,
      ...extra,
    });
  };
  const evalNote = `${modelName(input.models.evaluation)}, one recorded evaluation per case`;
  const reportNote = `${modelName(input.models.report)}, one recorded report per seeded case`;

  // Judge calibration first: it decides whether judged metrics may gate.
  const calibrationOf = (
    name: "conflict" | "disclosure",
    rows: Array<{ predicted: boolean; actual: boolean }>,
    positive: string,
  ): { calibration: BinaryCalibration | null; note: string } => {
    const calibration = calibrateBinary(rows, input.floor);
    if (!calibration) return { calibration, note: `${name} judge not calibrated: no judged labelled items` };
    const c = calibration.confusion;
    const note = `${name} judge precision ${fmt(c.precision)}, recall ${fmt(c.recall)} at detecting ${positive} (n=${c.n})`;
    const judgeMetric = (id: string, label: string, value: number | null, n: number) => {
      if (value === null) return;
      metrics.push({
        id: `contradiction.${corpusId}.judge.${name}.${id}`,
        label: `${label} (${corpusId})`,
        value,
        n,
        direction: "higher_is_better",
        provenance: "judged",
        corpus: corpusId,
        gate: false,
        note: `judge against human labels; positive class: ${positive}`,
      });
    };
    judgeMetric("precision", `${name === "conflict" ? "Conflict" : "Disclosure"} judge precision`, c.precision, c.tp + c.fp);
    judgeMetric("recall", `${name === "conflict" ? "Conflict" : "Disclosure"} judge recall`, c.recall, c.tp + c.fn);
    judgeMetric("agreement", `${name === "conflict" ? "Conflict" : "Disclosure"} judge agreement with human labels`, c.accuracy, c.n);
    if (!calibration.meetsFloor) {
      caveats.push(
        `The ${name} judge is below the floor (precision and recall >= ${input.floor.precision}/${input.floor.recall} over >= ${input.floor.n} labelled items; ${note}), so its judged metric is informational.`,
      );
    }
    return { calibration, note };
  };
  const conflictItems = conflictCalibrationItems(dataset);
  const conflictJudge = calibrationOf(
    "conflict",
    conflictItems.flatMap((item, i) => {
      const v = input.conflictCalibration[i]?.verdict;
      return v ? [{ predicted: v.verdict === "identified", actual: item.identifies }] : [];
    }),
    "notes that identify the conflict",
  );
  const disclosureJudge = calibrationOf(
    "disclosure",
    dataset.disclosure_calibration.flatMap((d, i) => {
      const v = input.disclosureCalibration[i]?.verdict;
      return v ? [{ predicted: v.verdict === "discloses", actual: d.discloses }] : [];
    }),
    "cues that disclose the conflict",
  );

  // Stage A: evaluateAnswer.
  const evaluated = (kind: CaseKind) => runs.flatMap((r) => (r.kind === kind && typeof r.evaluation === "object" ? [{ run: r, e: r.evaluation }] : []));
  const seededEval = evaluated("seeded");
  const controlEval = evaluated("control");
  rate("evaluation.detection", "Seeded contradictions detected by evaluateAnswer (flagged, detail names the location and the code fact)", seededEval.map(({ e }) => (e.identifies ? 1 : 0)), {
    provenance: "recorded_live",
    gate: input.gate,
    note: evalNote,
  });
  rate("evaluation.flag_rate", "Seeded contradictions flagged by evaluateAnswer (discrepancy set, detail not checked)", seededEval.map(({ e }) => (e.discrepancy ? 1 : 0)), {
    provenance: "recorded_live",
    gate: false,
    note: evalNote,
  });
  rate("evaluation.false_positive_rate", "Truthful controls flagged as contradictions by evaluateAnswer", controlEval.map(({ e }) => (e.discrepancy ? 1 : 0)), {
    provenance: "recorded_live",
    direction: "lower_is_better",
    gate: input.gate,
    note: evalNote,
  });

  // Stage B: the report, in tiers; only "conflict identified" counts.
  const reported = runs.flatMap((r) => (r.kind === "seeded" && typeof r.report === "object" ? [{ run: r, report: r.report }] : []));
  rate("report.location_cited", "Reports citing the contradicted location (tier 1, not identification)", reported.map(({ report }) => (report.notes.length > 0 ? 1 : 0)), {
    provenance: "recorded_live",
    gate: false,
    note: reportNote,
  });
  rate("report.conflict_anchored", "Reports with one note citing the location and stating both facets (deterministic)", reported.map(({ report }) => (report.notes.some((n) => n.anchored) ? 1 : 0)), {
    provenance: "recorded_live",
    gate: false,
    note: reportNote,
  });
  let identifiedMissing = 0;
  const identified = reported.flatMap(({ run, report }) => {
    if (!report.notes.some((n) => n.anchored)) return [0];
    const v = input.conflictVerdicts.get(run.id);
    if (!v?.verdict) {
      identifiedMissing++;
      return [];
    }
    return [v.verdict.verdict === "identified" ? 1 : 0];
  });
  rate("report.conflict_identified", "Reports identifying the conflict (tier 2: anchored note and judge agree)", identified, {
    provenance: "judged",
    gate: input.gate && conflictJudge.calibration !== null && conflictJudge.calibration.meetsFloor,
    note: `${conflictJudge.note}; ${reportNote}`,
  });
  const fed = reported.flatMap(({ report }) => (report.detailInInput === null ? [] : [report.detailInInput ? 1 : 0]));
  rate("report.detail_in_input", "Flagged cases whose discrepancy_detail reaches the report model", fed, {
    provenance: "recorded_live",
    gate: false,
    note: "whether buildReportInput passes the evaluation's discrepancy_detail to the report model",
  });

  // Stage C: the cue the voice interviewer receives.
  rate("interviewer.non_disclosure.patterns", "Seeded cases whose focus cue passes the disclosure patterns", seededEval.map(({ e }) => (e.disclosedByPattern ? 0 : 1)), {
    provenance: "recorded_live",
    gate: false,
    note: `${evalNote}; patterns: disclosure wording or the case's code-fact mentions`,
  });
  let disclosureMissing = 0;
  const nonDisclosed = seededEval.flatMap(({ run, e }) => {
    if (e.disclosedByPattern) return [0];
    if (!e.focus.trim()) return [1];
    const v = input.disclosureVerdicts.get(run.id);
    if (!v?.verdict) {
      disclosureMissing++;
      return [];
    }
    return [v.verdict.verdict === "neutral" ? 1 : 0];
  });
  rate("interviewer.non_disclosure", "Seeded cases whose focus cue does not reveal the discrepancy (patterns and judge)", nonDisclosed, {
    provenance: "judged",
    gate: input.gate && disclosureJudge.calibration !== null && disclosureJudge.calibration.meetsFloor,
    note: `${disclosureJudge.note}; ${evalNote}`,
  });

  // Caveats: coverage, the report-input finding, and what is not measured.
  const count = (pick: (r: CaseRun) => boolean) => runs.filter(pick).length;
  const evalNotRecorded = count((r) => r.evaluation === "not_recorded");
  const evalFailed = count((r) => r.evaluation === "failed");
  const reportNotRecorded = count((r) => r.report === "not_recorded");
  const reportFailed = count((r) => r.report === "failed");
  if (seededEval.length === 0 && controlEval.length === 0) {
    caveats.push(`contradiction detection not measured for ${corpusId}: no case has an evaluation${evalNotRecorded > 0 ? ' (outputs are not recorded; run "eval record" with OPENAI_API_KEY)' : ""}.`);
  } else if (evalNotRecorded > 0 || reportNotRecorded > 0) {
    caveats.push(`partial: ${evalNotRecorded} evaluation(s) and ${reportNotRecorded} report(s) are not recorded, so the metrics cover only part of the ${runs.length} cases.`);
  }
  if (evalFailed > 0) caveats.push(`evaluateAnswer reported a failure (for example invalid output) on ${evalFailed} case(s); they are excluded.`);
  if (reportFailed > 0) caveats.push(`report generation failed on ${reportFailed} seeded case(s); they are excluded from the report tiers.`);
  if (fed.length > 0 && fed.every((x) => x === 0)) {
    caveats.push(
      `Finding (not fixed here): discrepancy_detail reached the report model for none of ${fed.length} flagged case(s). buildReportInput in supabase/functions/inngest/report.ts passes only discrepancy_with_repository, so the report can state the conflict only by rediscovering it from the transcript and memory. report.detail_in_input and report.conflict_identified measure a fix before and after.`,
    );
  }
  const judgeMissing = [...input.conflictCalibration, ...input.disclosureCalibration, ...input.conflictVerdicts.values(), ...input.disclosureVerdicts.values()];
  const notRecordedJudge = judgeMissing.filter((j) => j.missing === "not_recorded").length;
  if (notRecordedJudge > 0) caveats.push(`judge not measured for ${notRecordedJudge} item(s): judgements are not recorded; run "eval record" with OPENAI_API_KEY.`);
  const invalidJudge = judgeMissing.filter((j) => j.missing === "invalid_output").length;
  if (invalidJudge > 0) caveats.push(`a judge returned invalid output for ${invalidJudge} item(s); they are excluded.`);
  if (identifiedMissing > 0) caveats.push(`${identifiedMissing} anchored report(s) have no conflict judgement and are excluded from report.conflict_identified.`);
  if (disclosureMissing > 0) caveats.push(`${disclosureMissing} focus cue(s) have no disclosure judgement and are excluded from interviewer.non_disclosure.`);
  caveats.push(
    "Report tiers: a report that only cites the contradicted file or symbol counts as location cited, never as conflict identified.",
    "guidance is an enum (follow_up, clarify, move_on) that cannot carry the discrepancy, so non-disclosure checks the focus cue the voice interviewer receives; the spoken Realtime interviewer is not evaluated.",
    `Each case is a one-turn interview from a fresh interview state. Seeded cases are planted flaws in the ${corpusId} corpus; their numbers are not real-repository results.`,
  );

  // Cases.
  const verdictText = (j: Judged<{ verdict: string; reason: string }> | undefined) => (j === undefined ? "not judged" : j.verdict ? `${j.verdict.verdict} (${j.verdict.reason})` : j.missing);
  const cases: NonNullable<SuiteResult["cases"]> = runs.map((r) => {
    const e = r.evaluation;
    const evalText = typeof e === "object"
      ? `evaluation: flagged=${e.discrepancy}${r.kind === "seeded" ? `, detail identifies=${e.identifies}` : ""}; detail "${e.detail}"; guidance ${e.guidance}; focus "${e.focus}"`
      : `evaluation ${e}`;
    if (r.kind === "control") {
      return { id: `control/${r.id}`, ok: typeof e === "object" && !e.discrepancy, detail: evalText };
    }
    const rep = r.report;
    const tier = typeof rep === "object"
      ? rep.notes.some((n) => n.anchored) ? "conflict anchored" : rep.notes.length > 0 ? "location cited" : "location not cited"
      : `report ${rep}`;
    const conflict = input.conflictVerdicts.get(r.id);
    const disclosure = input.disclosureVerdicts.get(r.id);
    const reportText = typeof rep === "object"
      ? `report: ${tier}; conflict judge ${verdictText(conflict)}; detail in report input ${rep.detailInInput ?? "n/a"}`
      : tier;
    const disclosureText = typeof e === "object" ? `; focus patterns ${e.disclosedByPattern ? "disclose" : "clean"}, disclosure judge ${verdictText(disclosure)}` : "";
    const ok = typeof e === "object" && e.identifies && !e.disclosedByPattern && disclosure?.verdict?.verdict !== "discloses" &&
      typeof rep === "object" && rep.notes.some((n) => n.anchored) && conflict?.verdict?.verdict === "identified";
    return { id: `seeded/${r.id}`, ok, detail: `${evalText}${disclosureText}; ${reportText}` };
  });
  conflictItems.forEach((item, i) => {
    const j = input.conflictCalibration[i];
    const ok = j?.verdict !== undefined && (j.verdict.verdict === "identified") === item.identifies;
    cases.push({ id: `conflict-calibration/${item.case.id}/${i + 1}`, ok, detail: `label identifies=${item.identifies}; judge ${verdictText(j)}; note "${item.text}"` });
  });
  dataset.disclosure_calibration.forEach((d, i) => {
    const j = input.disclosureCalibration[i];
    const ok = j?.verdict !== undefined && (j.verdict.verdict === "discloses") === d.discloses;
    cases.push({ id: `disclosure-calibration/${d.case}/${i + 1}`, ok, detail: `label discloses=${d.discloses}; judge ${verdictText(j)}; cue "${d.cue}"` });
  });
  return { metrics, cases, caveats };
}

async function mapLimited<T, R>(items: readonly T[], fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index], index);
    }
  }));
  return out;
}
