import { z } from "zod";

// Hidden interview state written by the planning job (`interview_state`). Never sent to clients.
// Objects are strict and every field is required so the same schema can be used as an OpenAI
// structured-output schema.

const areaIdSchema = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);

const shortText = z.string().min(1).max(300);

export const coverageAreaStatusSchema = z.enum(["not_started", "partial", "covered"]);

export const coverageAreaSchema = z.strictObject({
  id: areaIdSchema,
  name: z.string().min(1).max(80),
  priority: z.enum(["high", "medium", "low"]),
  /** Why the area matters for this repository. */
  rationale: shortText,
  topics: z.array(shortText).min(1).max(8),
  /** Files, modules, or technologies from repository memory that ground the area. */
  repo_evidence: z.array(shortText).max(10),
  status: coverageAreaStatusSchema,
});

export const coverageMapSchema = z.strictObject({
  areas: z.array(coverageAreaSchema).min(3).max(10),
});

export const interviewPhaseSchema = z.strictObject({
  title: z.string().min(1).max(80),
  coverage_area_ids: z.array(areaIdSchema).min(1).max(6),
  goals: z.array(shortText).min(1).max(5),
  minutes: z.int().min(2).max(20),
});

export const interviewPlanSchema = z.strictObject({
  summary: z.string().min(1).max(800),
  phases: z.array(interviewPhaseSchema).min(2).max(6),
  opening_question: z.string().min(1).max(500),
});

export const interviewStrategySchema = z.strictObject({
  difficulty: z.enum(["foundational", "intermediate", "advanced"]),
  /** Coverage area ids to emphasize, e.g. gaps from earlier interviews. */
  focus_area_ids: z.array(areaIdSchema).max(6),
  /** Topics already explored in earlier interviews; prefer new angles over repeats. */
  avoid_repeating: z.array(shortText).max(10),
  follow_up_style: shortText,
  notes: z.array(shortText).max(8),
});

export const interviewPlanningOutputSchema = z.strictObject({
  coverage_map: coverageMapSchema,
  plan: interviewPlanSchema,
  strategy: interviewStrategySchema,
});

export type CoverageAreaStatus = z.infer<typeof coverageAreaStatusSchema>;
export type CoverageArea = z.infer<typeof coverageAreaSchema>;
export type CoverageMap = z.infer<typeof coverageMapSchema>;
export type InterviewPhase = z.infer<typeof interviewPhaseSchema>;
export type InterviewPlan = z.infer<typeof interviewPlanSchema>;
export type InterviewStrategy = z.infer<typeof interviewStrategySchema>;
export type InterviewPlanningOutput = z.infer<typeof interviewPlanningOutputSchema>;
