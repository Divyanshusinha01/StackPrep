/**
 * The checkable text of the pipeline, split into units by schema field. Every unit is checked for
 * citation validity; "claim" units also feed claim support, paired with their own citations.
 *
 * Roles:
 * - claim: states facts about the repository that cited code can support or refute;
 * - text: checked for valid citations only (questions, topics, advice, cues, what the candidate said);
 * - reference: the value names a location (repo_evidence items: files, modules or technologies);
 * - path: the whole value must be a repository path (`repository_evidence[].path`).
 *
 * The live voice interviewer's spoken questions are not a surface: they cannot be regenerated offline.
 */
import type { InterviewPlanningOutput, InterviewReport } from "@stackprep/shared";
import { type Citation, extractCitations, strictPathCitation } from "./citations.ts";
import type { EvaluatedTurn } from "./evaluate.ts";
import type { PipelineRun } from "./sessions.ts";

export const SURFACES = ["plan", "evaluation", "report_ungrounded", "report"] as const;
export type Surface = typeof SURFACES[number];

export const SURFACE_LABELS: Record<Surface, string> = {
  plan: "interview plan",
  evaluation: "answer evaluations",
  report_ungrounded: "report before groundReport",
  report: "report",
};

export type UnitRole = "claim" | "text" | "reference" | "path";

export interface TextUnit {
  surface: Surface;
  /** Where the text came from, e.g. "s1/q2". */
  at: string;
  /** Schema field with indexes, e.g. "evaluation.gaps[0]". */
  field: string;
  text: string;
  role: UnitRole;
  /** A location the schema binds to this claim (a repository_evidence note to its path, a weakness to its area). */
  bound?: { text: string; strict: boolean };
}

export function planUnits(plan: InterviewPlanningOutput): TextUnit[] {
  const unit = (field: string, text: string, role: UnitRole): TextUnit => ({ surface: "plan", at: "plan", field, text, role });
  return [
    unit("plan.summary", plan.plan.summary, "claim"),
    unit("plan.opening_question", plan.plan.opening_question, "text"),
    ...plan.plan.phases.flatMap((p, i) => p.goals.map((g, j) => unit(`plan.phases[${i}].goals[${j}]`, g, "text"))),
    ...plan.coverage_map.areas.flatMap((a, i) => [
      unit(`coverage.areas[${i}].rationale`, a.rationale, "claim"),
      ...a.topics.map((t, j) => unit(`coverage.areas[${i}].topics[${j}]`, t, "text")),
      ...a.repo_evidence.map((r, j) => unit(`coverage.areas[${i}].repo_evidence[${j}]`, r, "reference")),
    ]),
  ];
}

export function evaluationUnits(at: string, turn: EvaluatedTurn): TextUnit[] {
  const { record, output } = turn;
  const unit = (field: string, text: string, role: UnitRole): TextUnit => ({ surface: "evaluation", at, field, text, role });
  return [
    ...record.strengths.map((s, i) => unit(`evaluation.strengths[${i}]`, s, "claim")),
    ...record.gaps.map((g, i) => unit(`evaluation.gaps[${i}]`, g, "claim")),
    ...record.repo_evidence.map((r, i) => unit(`evaluation.repo_evidence[${i}]`, r, "reference")),
    ...(record.discrepancy_detail ? [unit("evaluation.discrepancy_detail", record.discrepancy_detail, "claim")] : []),
    ...(output.focus ? [unit("evaluation.focus", output.focus, "text")] : []),
  ];
}

export function reportUnits(surface: "report" | "report_ungrounded", at: string, report: InterviewReport): TextUnit[] {
  const unit = (field: string, text: string, role: UnitRole, bound?: TextUnit["bound"]): TextUnit => ({
    surface,
    at,
    field,
    text,
    role,
    ...(bound ? { bound } : {}),
  });
  return [
    unit("report.executive_summary", report.executive_summary, "claim"),
    ...report.categories.map((c, i) => unit(`report.categories[${i}].narrative`, c.narrative, "claim")),
    ...report.strengths.map((s, i) => unit(`report.strengths[${i}]`, s, "claim")),
    ...report.gaps.map((g, i) => unit(`report.gaps[${i}]`, g, "claim")),
    ...report.interview_evidence.map((e, i) => unit(`report.interview_evidence[${i}].observation`, e.observation, "text")),
    ...report.repository_evidence.flatMap((e, i) => [
      unit(`report.repository_evidence[${i}].path`, e.path, "path"),
      unit(`report.repository_evidence[${i}].note`, e.note, "claim", { text: e.path, strict: true }),
    ]),
    ...report.areas_to_improve.map((a, i) => unit(`report.areas_to_improve[${i}]`, a, "text")),
    ...report.struggled_questions.flatMap((q, i) => [
      unit(`report.struggled_questions[${i}].question`, q.question, "text"),
      unit(`report.struggled_questions[${i}].performance`, q.performance, "text"),
      unit(`report.struggled_questions[${i}].weakness`, q.weakness, "claim", { text: q.repository_area, strict: false }),
      unit(`report.struggled_questions[${i}].repository_area`, q.repository_area, "reference"),
      unit(`report.struggled_questions[${i}].learning_direction`, q.learning_direction, "text"),
    ]),
  ];
}

/** Every unit of a pipeline run, in a stable order: plan, then per session its evaluations and reports. */
export function pipelineUnits(run: PipelineRun): TextUnit[] {
  const units = run.plan ? planUnits(run.plan) : [];
  for (const session of run.sessions) {
    session.turns.forEach((turn, i) => {
      if (turn.evaluation) units.push(...evaluationUnits(`${session.id}/q${i + 1}`, turn.evaluation));
    });
    if (session.report) {
      units.push(...reportUnits("report_ungrounded", `${session.id}/report`, session.report.ungrounded));
      units.push(...reportUnits("report", `${session.id}/report`, session.report.grounded));
    }
  }
  return units;
}

/** Citations a unit makes on its own (bound locations are only used to pair claims). */
export function unitCitations(unit: TextUnit, paths: Iterable<string>): Citation[] {
  return unit.role === "path" ? [strictPathCitation(unit.text)] : extractCitations(unit.text, paths);
}

/** Citations a claim is paired with: its own plus the location the schema binds to it. */
export function claimCitations(unit: TextUnit, paths: readonly string[]): Citation[] {
  const own = extractCitations(unit.text, paths);
  if (!unit.bound) return own;
  const bound = unit.bound.strict ? [strictPathCitation(unit.bound.text)] : extractCitations(unit.bound.text, paths);
  return [...own, ...bound];
}
