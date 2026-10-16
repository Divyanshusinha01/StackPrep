import {
  type AnswerAssessment,
  conceptIdSchema,
  type LearningPlanItem,
  type LearningReport,
  learningReportSchema,
  legacyInterviewReportSchema,
  MAX_QUESTION_REVIEWS,
  MAX_REPORT_CONCEPTS,
  type QuestionReview,
  type ReportConcept,
  type ReportRating,
  reportRatingSchema,
} from "@stackprep/shared";
import { z } from "zod";
import { scrubSecrets } from "../_shared/analysis/scrub.ts";
import { AIInvalidOutputError } from "../_shared/ai/provider.ts";
import type { ReportContext, ReportEvaluation, ReportMessage } from "./report-store.ts";

// What the report model returns. Lengths are looser than the stored schema: the server clips
// after scrubbing, so a slightly long field is trimmed instead of failing the whole report.
// Transcript-sourced fields (question, candidate answer) and the assessment are never asked for.

const modelText = (max: number) => z.string().min(1).max(max);

const modelQuestionReviewSchema = z.strictObject({
  question_message_id: z.string().max(64),
  expected_answer: modelText(4000),
  ideal_answer: modelText(8000),
  factual_errors: z.array(modelText(600)).max(6),
  missing_concepts: z.array(modelText(600)).max(6),
  communication: z.array(modelText(600)).max(6),
  valid_alternatives: z.array(modelText(700)).max(4),
  how_to_improve: z.array(modelText(600)).min(1).max(6),
  concept_ids: z.array(z.string().max(60)).max(4),
});

const modelConceptSchema = z.strictObject({
  id: z.string().max(60),
  name: modelText(120),
  explanation: modelText(1600),
  why_it_matters: modelText(900),
  question_ids: z.array(z.string().max(64)).max(MAX_QUESTION_REVIEWS),
  /** Generic technical search terms only; checked again before any search runs. */
  search_query: z.string().max(120),
});

const modelLearningPlanItemSchema = z.strictObject({
  priority: z.int().min(1).max(10),
  concept_id: z.string().max(60),
  exercise: modelText(700),
  success_check: modelText(450),
  effort_minutes: z.int().min(5).max(600),
});

const { struggled_questions: _legacyOnly, ...legacyShape } = legacyInterviewReportSchema.shape;

export const learningReportModelSchema = z.strictObject({
  ...legacyShape,
  question_reviews: z.array(modelQuestionReviewSchema).max(MAX_QUESTION_REVIEWS + 2),
  concepts: z.array(modelConceptSchema).max(MAX_REPORT_CONCEPTS + 2),
  learning_plan: z.array(modelLearningPlanItemSchema).max(8),
  final_recommendations: z.array(modelText(600)).max(5),
});

export type LearningReportModelOutput = z.infer<typeof learningReportModelSchema>;

/** A concept to find learning resources for. `query` has not been vetted yet. */
export interface ConceptSearch {
  concept_id: string;
  name: string;
  query: string;
}

export interface HydratedLearningReport {
  report: LearningReport;
  searches: ConceptSearch[];
}

const MAX_ANSWER_CHARS = 4000;
const MAX_QUESTION_CHARS = 2000;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Scrubbed, trimmed, and clipped; "" when nothing is left. */
function clean(text: string, max: number): string {
  return clip(scrubSecrets(text).trim(), max);
}

function cleanList(items: string[], max: number, limit: number): string[] {
  return items.map((item) => clean(item, max)).filter(Boolean).slice(0, limit);
}

/**
 * The assessment shown for a question, derived only from the evaluation recorded during the
 * interview (1-5 score, falling back to the rating) and whether the candidate said anything.
 */
export function assessAnswer(score: number | null, rating: string | null, answered: boolean): AnswerAssessment {
  if (!answered) {
    return "unanswered";
  }
  if (score !== null) {
    return score >= 4 ? "correct" : score === 3 ? "partially_correct" : "incorrect";
  }
  switch (rating) {
    case "strong":
    case "proficient":
      return "correct";
    case "weak":
      return "incorrect";
    default:
      return "partially_correct";
  }
}

export interface EvaluatedQuestion {
  question: ReportMessage;
  /** Candidate turns after the question, up to the next interviewer turn. */
  answer: ReportMessage[];
  evaluation: ReportEvaluation;
}

/** One entry per evaluated question (latest evaluation wins), in transcript order. */
export function evaluatedQuestions(context: ReportContext): EvaluatedQuestion[] {
  const messages = [...context.messages].sort((a, b) => a.sequence - b.sequence);
  const latest = new Map<string, ReportEvaluation>();
  for (const evaluation of context.evaluations) {
    latest.set(evaluation.message_id, evaluation);
  }
  const result: EvaluatedQuestion[] = [];
  messages.forEach((message, index) => {
    const evaluation = latest.get(message.id);
    if (!evaluation || message.role !== "ai") {
      return;
    }
    const answer: ReportMessage[] = [];
    for (const next of messages.slice(index + 1)) {
      if (next.role === "ai") {
        break;
      }
      if (next.role === "user") {
        answer.push(next);
      }
    }
    result.push({ question: message, answer, evaluation });
  });
  return result;
}

export function candidateAnswerText(answer: ReportMessage[]): { text: string; truncated: boolean } {
  const full = scrubSecrets(answer.map((m) => m.content.trim()).filter(Boolean).join("\n\n"));
  return full.length <= MAX_ANSWER_CHARS
    ? { text: full, truncated: false }
    : { text: clip(full, MAX_ANSWER_CHARS), truncated: true };
}

function ratingOf(value: string | null): ReportRating {
  const parsed = reportRatingSchema.safeParse(value);
  return parsed.success ? parsed.data : "insufficient_evidence";
}

const SEVERITY: Record<AnswerAssessment, number> = { incorrect: 0, partially_correct: 1, unanswered: 2, correct: 3 };

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
}

/** A valid, unique concept id derived from the model's id or the concept name; null if neither works. */
function conceptId(raw: string, name: string, taken: Set<string>): string | null {
  for (const candidate of [raw.trim().toLowerCase(), slug(raw), slug(name)]) {
    if (candidate && conceptIdSchema.safeParse(candidate).success && !taken.has(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Builds the stored learning report. Every transcript-sourced field is filled from PostgreSQL, never
 * from model output; reviews and concepts that reference unknown ids are dropped; every text field
 * is scrubbed of secrets and clipped to the stored limits.
 */
export function hydrateLearningReport(output: LearningReportModelOutput, context: ReportContext): HydratedLearningReport {
  const questions = new Map(evaluatedQuestions(context).map((q) => [q.question.id, q]));

  const seen = new Set<string>();
  const drafts: { review: Omit<QuestionReview, "concept_ids">; rawConcepts: string[]; sequence: number }[] = [];
  for (const r of output.question_reviews) {
    const source = questions.get(r.question_message_id);
    if (!source || seen.has(source.question.id)) {
      continue;
    }
    const question = clean(source.question.content, MAX_QUESTION_CHARS);
    const howToImprove = cleanList(r.how_to_improve, 400, 6);
    const expected = clean(r.expected_answer, 3000);
    const ideal = clean(r.ideal_answer, 6000);
    if (!question || !expected || !ideal || howToImprove.length === 0) {
      continue;
    }
    seen.add(source.question.id);
    const { text: answer, truncated } = candidateAnswerText(source.answer);
    const evaluation = source.evaluation;
    drafts.push({
      sequence: source.question.sequence,
      rawConcepts: r.concept_ids,
      review: {
        question_message_id: source.question.id,
        question,
        candidate_answer: answer,
        answer_truncated: truncated,
        assessment: assessAnswer(evaluation.score, evaluation.rating, answer.length > 0),
        evaluator_rating: ratingOf(evaluation.rating),
        evaluator_strengths: cleanList(evaluation.strengths, 300, 5),
        evaluator_gaps: cleanList(evaluation.gaps, 300, 5),
        repository_area: clean(evaluation.repo_evidence[0] ?? "", 300),
        expected_answer: expected,
        ideal_answer: ideal,
        factual_errors: cleanList(r.factual_errors, 400, 6),
        missing_concepts: cleanList(r.missing_concepts, 400, 6),
        communication: cleanList(r.communication, 400, 6),
        valid_alternatives: cleanList(r.valid_alternatives, 500, 4),
        how_to_improve: howToImprove,
      },
    });
  }
  const kept = drafts
    .sort((a, b) => SEVERITY[a.review.assessment] - SEVERITY[b.review.assessment] || a.sequence - b.sequence)
    .slice(0, MAX_QUESTION_REVIEWS)
    .sort((a, b) => a.sequence - b.sequence);
  const keptIds = new Set(kept.map((d) => d.review.question_message_id));

  const conceptIds = new Map<string, string>();
  const concepts: ReportConcept[] = [];
  const searches: ConceptSearch[] = [];
  const taken = new Set<string>();
  for (const c of output.concepts) {
    if (concepts.length >= MAX_REPORT_CONCEPTS) {
      break;
    }
    const name = clean(c.name, 80);
    const explanation = clean(c.explanation, 1200);
    const why = clean(c.why_it_matters, 600);
    const id = name ? conceptId(c.id, name, taken) : null;
    if (!id || !explanation || !why) {
      continue;
    }
    taken.add(id);
    conceptIds.set(c.id, id);
    concepts.push({
      id,
      name,
      explanation,
      why_it_matters: why,
      question_ids: [...new Set(c.question_ids.filter((q) => keptIds.has(q)))],
      resources_status: "not_attempted",
      resources: [],
    });
    searches.push({ concept_id: id, name, query: c.search_query });
  }
  const known = (raw: string): string | undefined => conceptIds.get(raw) ?? (taken.has(raw) ? raw : undefined);

  const questionReviews: QuestionReview[] = kept.map(({ review, rawConcepts }) => ({
    ...review,
    concept_ids: [...new Set(rawConcepts.map(known).filter((id): id is string => id !== undefined))].slice(0, 4),
  }));

  const learningPlan: LearningPlanItem[] = output.learning_plan
    .map((item) => ({
      priority: item.priority,
      concept_id: known(item.concept_id) ?? "",
      exercise: clean(item.exercise, 500),
      success_check: clean(item.success_check, 300),
      effort_minutes: item.effort_minutes,
    }))
    .filter((item) => item.exercise && item.success_check)
    .sort((a, b) => a.priority - b.priority)
    .map((item, index) => ({ ...item, priority: index + 1 }));

  const report = {
    report_version: 2 as const,
    executive_summary: clean(output.executive_summary, 2000),
    categories: output.categories.map((c) => ({
      name: clean(c.name, 80),
      rating: c.rating,
      narrative: clean(c.narrative, 1200),
    })),
    strengths: cleanList(output.strengths, 400, 10),
    gaps: cleanList(output.gaps, 400, 10),
    interview_evidence: output.interview_evidence
      .map((e) => ({ category: clean(e.category, 80), observation: clean(e.observation, 500) }))
      .filter((e) => e.category && e.observation),
    repository_evidence: output.repository_evidence
      .map((e) => ({ path: clean(e.path, 300), note: clean(e.note, 500) }))
      .filter((e) => e.path && e.note),
    areas_to_improve: cleanList(output.areas_to_improve, 400, 10),
    struggled_questions: [],
    question_reviews: questionReviews,
    concepts,
    learning_plan: learningPlan,
    final_recommendations: cleanList(output.final_recommendations, 400, 5),
  };
  const parsed = learningReportSchema.safeParse(report);
  if (!parsed.success) {
    throw new AIInvalidOutputError("schema_mismatch");
  }
  return { report: parsed.data, searches };
}
