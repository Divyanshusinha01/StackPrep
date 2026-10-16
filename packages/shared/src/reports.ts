import { z } from "zod";

// Interview report (PRD sections 26-27), stored in `reports.content`. Objects are strict and every
// field is required so the same schema can be used as an OpenAI structured-output schema.
// There is deliberately no overall score, no ranking, and no field for an expected answer.

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

/** A question the candidate struggled with. Points toward what to study, never the answer. */
export const reportStruggledQuestionSchema = z.strictObject({
  question: text(500),
  performance: text(600),
  weakness: text(400),
  repository_area: text(300),
  learning_direction: text(600),
});

export const interviewReportSchema = z.strictObject({
  executive_summary: text(2000),
  categories: z.array(reportCategorySchema).min(1).max(10),
  strengths: z.array(text(400)).max(10),
  gaps: z.array(text(400)).max(10),
  interview_evidence: z.array(reportInterviewEvidenceSchema).max(15),
  repository_evidence: z.array(reportRepositoryEvidenceSchema).max(15),
  areas_to_improve: z.array(text(400)).max(10),
  struggled_questions: z.array(reportStruggledQuestionSchema).max(8),
});

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

export const interviewReportResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("ready"), report: interviewReportSchema, generated_at: timestampSchema }),
  z.object({ status: z.literal("failed"), error_code: reportErrorCodeSchema }),
]);

export type ReportRating = z.infer<typeof reportRatingSchema>;
export type ReportCategory = z.infer<typeof reportCategorySchema>;
export type ReportInterviewEvidence = z.infer<typeof reportInterviewEvidenceSchema>;
export type ReportRepositoryEvidence = z.infer<typeof reportRepositoryEvidenceSchema>;
export type ReportStruggledQuestion = z.infer<typeof reportStruggledQuestionSchema>;
export type InterviewReport = z.infer<typeof interviewReportSchema>;
export type ReportState = z.infer<typeof reportStateSchema>;
export type ReportErrorCode = z.infer<typeof reportErrorCodeSchema>;
export type InterviewReportResponse = z.infer<typeof interviewReportResponseSchema>;
