import { z } from "zod";

// Hidden interview state written by the planning job (`interview_state`). Never sent to clients.
// Objects are strict and every field is required so the same schema can be used as an OpenAI
// structured-output schema.

/** String caps on the stored plan. OpenAI strict schemas drop length limits, so the planner clips to these. */
export const INTERVIEW_PLANNING_LIMITS = {
  nameChars: 80,
  shortTextChars: 300,
  summaryChars: 800,
  openingQuestionChars: 500,
} as const;

const L = INTERVIEW_PLANNING_LIMITS;

const areaIdSchema = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);

export const coverageAreaStatusSchema = z.enum(["not_started", "partial", "covered"]);

function planningOutputSchema(text: (max: number) => z.ZodString) {
  const shortText = text(L.shortTextChars);
  const coverageArea = z.strictObject({
    id: areaIdSchema,
    name: text(L.nameChars),
    priority: z.enum(["high", "medium", "low"]),
    /** Why the area matters for this repository. */
    rationale: shortText,
    topics: z.array(shortText).min(1).max(8),
    /** Files, modules, or technologies from repository memory that ground the area. */
    repo_evidence: z.array(shortText).max(10),
    status: coverageAreaStatusSchema,
  });
  const coverageMap = z.strictObject({
    areas: z.array(coverageArea).min(3).max(10),
  });
  const phase = z.strictObject({
    title: text(L.nameChars),
    coverage_area_ids: z.array(areaIdSchema).min(1).max(6),
    goals: z.array(shortText).min(1).max(5),
    minutes: z.int().min(2).max(20),
  });
  const plan = z.strictObject({
    summary: text(L.summaryChars),
    phases: z.array(phase).min(2).max(6),
    opening_question: text(L.openingQuestionChars),
  });
  const strategy = z.strictObject({
    difficulty: z.enum(["foundational", "intermediate", "advanced"]),
    /** Coverage area ids to emphasize, e.g. gaps from earlier interviews. */
    focus_area_ids: z.array(areaIdSchema).max(6),
    /** Topics already explored in earlier interviews; prefer new angles over repeats. */
    avoid_repeating: z.array(shortText).max(10),
    follow_up_style: shortText,
    notes: z.array(shortText).max(8),
  });
  return { coverageArea, coverageMap, phase, plan, strategy, output: z.strictObject({ coverage_map: coverageMap, plan, strategy }) };
}

const stored = planningOutputSchema((max) => z.string().min(1).max(max));

export const coverageAreaSchema = stored.coverageArea;
export const coverageMapSchema = stored.coverageMap;
export const interviewPhaseSchema = stored.phase;
export const interviewPlanSchema = stored.plan;
export const interviewStrategySchema = stored.strategy;
export const interviewPlanningOutputSchema = stored.output;

/** Provider output: same shape without string caps, so a slightly long answer is clipped rather than rejected. */
export const interviewPlanningProviderOutputSchema = planningOutputSchema(() => z.string()).output;

export type CoverageAreaStatus = z.infer<typeof coverageAreaStatusSchema>;
export type CoverageArea = z.infer<typeof coverageAreaSchema>;
export type CoverageMap = z.infer<typeof coverageMapSchema>;
export type InterviewPhase = z.infer<typeof interviewPhaseSchema>;
export type InterviewPlan = z.infer<typeof interviewPlanSchema>;
export type InterviewStrategy = z.infer<typeof interviewStrategySchema>;
export type InterviewPlanningOutput = z.infer<typeof interviewPlanningOutputSchema>;
export type InterviewPlanningProviderOutput = z.infer<typeof interviewPlanningProviderOutputSchema>;
