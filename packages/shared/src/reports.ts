import { z } from "zod";

// Interview report (PRD sections 26-27), stored in `reports.content`. Objects are strict and every
// field is required so the same shapes can back OpenAI structured-output schemas.
// There is deliberately no overall score and no ranking.

const text = (max: number) => z.string().min(1).max(max);

const timestampSchema = z.iso.datetime({ offset: true });

export const reportRatingSchema = z.enum(["strong", "proficient", "developing", "weak", "insufficient_evidence"]);

export const reportCategorySchema = z.strictObject({
  name: text(80),
  /** Qualitative only; never a number. */
  rating: reportRatingSchema,
  narrative: text(1200),
});

export const reportInterviewEvidenceSchema = z.strictObject({
  category: text(80),
  /** What the candidate said or did, paraphrased from the transcript. */
  observation: text(500),
});

export const reportRepositoryEvidenceSchema = z.strictObject({
  path: text(300),
  note: text(500),
});

/** A question the candidate struggled with (legacy reports). Points toward what to study. */
export const reportStruggledQuestionSchema = z.strictObject({
  question: text(500),
  performance: text(600),
  weakness: text(400),
  repository_area: text(300),
  learning_direction: text(600),
});

const legacyReportShape = {
  executive_summary: text(2000),
  categories: z.array(reportCategorySchema).min(1).max(10),
  strengths: z.array(text(400)).max(10),
  gaps: z.array(text(400)).max(10),
  interview_evidence: z.array(reportInterviewEvidenceSchema).max(15),
  repository_evidence: z.array(reportRepositoryEvidenceSchema).max(15),
  areas_to_improve: z.array(text(400)).max(10),
  struggled_questions: z.array(reportStruggledQuestionSchema).max(8),
};

/** Reports stored before learning reports: no `report_version`, no reference answers. */
export const legacyInterviewReportSchema = z.strictObject(legacyReportShape);

/** @deprecated Kept for existing callers; the legacy (version 1) report shape. */
export const interviewReportSchema = legacyInterviewReportSchema;

// Learning report (report_version 2) -------------------------------------------------------

export const MAX_QUESTION_REVIEWS = 10;
export const MAX_REPORT_CONCEPTS = 6;
export const MAX_CONCEPT_RESOURCES = 3;

/** Derived server-side from the stored evaluation; the model never chooses it. */
export const answerAssessmentSchema = z.enum(["correct", "partially_correct", "incorrect", "unanswered"]);

export const conceptIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);

export const learningResourceSchema = z.strictObject({
  /** From the search tool's citation, never typed by the model. */
  title: text(200),
  /** Hostname of the URL. */
  publisher: text(120),
  url: z.url({ protocol: /^https$/ }).max(2000),
  what_to_learn: text(400),
  /** The gap or mistake this resource addresses. */
  addresses: text(300),
});

export const resourcesStatusSchema = z.enum(["ok", "unavailable", "not_attempted"]);

export const reportConceptSchema = z.strictObject({
  id: conceptIdSchema,
  name: text(80),
  explanation: text(1200),
  why_it_matters: text(600),
  question_ids: z.array(z.uuid()).max(MAX_QUESTION_REVIEWS),
  resources_status: resourcesStatusSchema,
  resources: z.array(learningResourceSchema).max(MAX_CONCEPT_RESOURCES),
});

export const questionReviewSchema = z.strictObject({
  // From the transcript, filled by the server.
  question_message_id: z.uuid(),
  question: text(2000),
  /** The candidate's own words; "" when they gave no answer. */
  candidate_answer: z.string().max(4000),
  answer_truncated: z.boolean(),
  // From the evaluation recorded during the interview.
  assessment: answerAssessmentSchema,
  evaluator_rating: reportRatingSchema,
  evaluator_strengths: z.array(text(300)).max(5),
  evaluator_gaps: z.array(text(300)).max(5),
  repository_area: z.string().max(300),
  // AI-generated reference material.
  expected_answer: text(3000),
  /** Markdown; fenced code blocks allowed. */
  ideal_answer: text(6000),
  factual_errors: z.array(text(400)).max(6),
  missing_concepts: z.array(text(400)).max(6),
  communication: z.array(text(400)).max(6),
  valid_alternatives: z.array(text(500)).max(4),
  how_to_improve: z.array(text(400)).min(1).max(6),
  concept_ids: z.array(conceptIdSchema).max(4),
});

/** Where each part of a question review comes from; the UI labels them accordingly. */
export const QUESTION_REVIEW_PROVENANCE = {
  transcript: ["question", "candidate_answer"],
  evaluator_judgment: ["assessment", "evaluator_rating", "evaluator_strengths", "evaluator_gaps"],
  ai_reference: [
    "expected_answer",
    "ideal_answer",
    "factual_errors",
    "missing_concepts",
    "communication",
    "valid_alternatives",
    "how_to_improve",
  ],
} as const satisfies Record<string, readonly (keyof z.infer<typeof questionReviewSchema>)[]>;

export const learningPlanItemSchema = z.strictObject({
  priority: z.int().min(1).max(10),
  /** A concept id from the report, or "" for general practice. */
  concept_id: z.union([conceptIdSchema, z.literal("")]),
  exercise: text(500),
  success_check: text(300),
  effort_minutes: z.int().min(5).max(600),
});

export const learningReportSchema = z.strictObject({
  report_version: z.literal(2),
  ...legacyReportShape,
  question_reviews: z.array(questionReviewSchema).max(MAX_QUESTION_REVIEWS),
  concepts: z.array(reportConceptSchema).max(MAX_REPORT_CONCEPTS),
  learning_plan: z.array(learningPlanItemSchema).max(8),
  final_recommendations: z.array(text(400)).max(5),
});

/** Any stored report: learning reports first, then the legacy shape. */
export const storedInterviewReportSchema = z.union([learningReportSchema, legacyInterviewReportSchema]);

export function isLearningReport(report: StoredInterviewReport): report is LearningReport {
  return "report_version" in report && report.report_version === 2;
}

// GET /interviews/:id/report ----------------------------------------------------------
// Derived from the `reports` row and the interview's latest `report_generation` job.

export const reportStateSchema = z.enum(["pending", "ready", "failed"]);

/** Fixed failure codes recorded on the report job; never raw error messages. */
export const reportErrorCodeSchema = z.enum([
  "transcript_unavailable",
  "ai_rate_limited",
  "ai_unavailable",
  "ai_invalid_output",
  "openai_key_unavailable",
  "openai_key_invalid",
  "openai_quota_exhausted",
  "enqueue_failed",
  "internal_error",
]);

/** Regeneration of a legacy report into a learning report; the legacy report stays until it succeeds. */
export const reportUpgradeStateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("failed"), error_code: reportErrorCodeSchema }),
]);

export const interviewReportResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  z.object({
    status: z.literal("ready"),
    report: storedInterviewReportSchema,
    generated_at: timestampSchema,
    upgrade: reportUpgradeStateSchema.optional(),
  }),
  z.object({ status: z.literal("failed"), error_code: reportErrorCodeSchema }),
]);

export type ReportRating = z.infer<typeof reportRatingSchema>;
export type ReportCategory = z.infer<typeof reportCategorySchema>;
export type ReportInterviewEvidence = z.infer<typeof reportInterviewEvidenceSchema>;
export type ReportRepositoryEvidence = z.infer<typeof reportRepositoryEvidenceSchema>;
export type ReportStruggledQuestion = z.infer<typeof reportStruggledQuestionSchema>;
/** The legacy (version 1) report shape, which learning reports extend. */
export type InterviewReport = z.infer<typeof legacyInterviewReportSchema>;
export type AnswerAssessment = z.infer<typeof answerAssessmentSchema>;
export type LearningResource = z.infer<typeof learningResourceSchema>;
export type ResourcesStatus = z.infer<typeof resourcesStatusSchema>;
export type ReportConcept = z.infer<typeof reportConceptSchema>;
export type QuestionReview = z.infer<typeof questionReviewSchema>;
export type LearningPlanItem = z.infer<typeof learningPlanItemSchema>;
export type LearningReport = z.infer<typeof learningReportSchema>;
export type StoredInterviewReport = z.infer<typeof storedInterviewReportSchema>;
export type ReportState = z.infer<typeof reportStateSchema>;
export type ReportErrorCode = z.infer<typeof reportErrorCodeSchema>;
export type InterviewReportResponse = z.infer<typeof interviewReportResponseSchema>;
export type ReportUpgradeState = z.infer<typeof reportUpgradeStateSchema>;
