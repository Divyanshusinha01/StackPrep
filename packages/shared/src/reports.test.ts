import { describe, expect, it } from "vitest";
import { z } from "zod";
import { apiErrorCodeSchema } from "./github.ts";
import {
  interviewReportResponseSchema,
  type InterviewReport,
  isLearningReport,
  type LearningReport,
  learningReportSchema,
  legacyInterviewReportSchema,
  storedInterviewReportSchema,
} from "./reports.ts";

const report = {
  executive_summary: "Explained the request pipeline well; data modeling answers were shallow.",
  categories: [{ name: "Architecture", rating: "proficient", narrative: "Traced a request end to end." }],
  strengths: ["Clear explanation of the middleware chain"],
  gaps: ["Unsure how migrations are rolled back"],
  interview_evidence: [{ category: "Architecture", observation: "Described how src/server.ts wires routes." }],
  repository_evidence: [{ path: "src/server.ts", note: "Route registration discussed in depth." }],
  areas_to_improve: ["Review the migration rollback strategy"],
  struggled_questions: [{
    question: "How would you roll back a failed migration?",
    performance: "Described re-running migrations but not reverting them.",
    weakness: "Migration rollback",
    repository_area: "supabase/migrations",
    learning_direction: "Study how forward-only migrations handle failures.",
  }],
} satisfies InterviewReport;

const QUESTION_ID = "11111111-1111-4111-8111-111111111111";

const learning = {
  report_version: 2,
  ...report,
  struggled_questions: [],
  question_reviews: [{
    question_message_id: QUESTION_ID,
    question: "How would you roll back a failed migration?",
    candidate_answer: "I would just run the migrations again.",
    answer_truncated: false,
    assessment: "incorrect",
    evaluator_rating: "weak",
    evaluator_strengths: [],
    evaluator_gaps: ["No rollback strategy"],
    repository_area: "supabase/migrations",
    expected_answer: "Forward-only migrations are fixed by a new corrective migration.",
    ideal_answer: "Write a new migration that reverts the change:\n\n```sql\nalter table t drop column c;\n```",
    factual_errors: ["Re-running a failed migration does not revert partial changes."],
    missing_concepts: ["Transactional DDL"],
    communication: [],
    valid_alternatives: ["Restore from a point-in-time backup for data loss."],
    how_to_improve: ["Read how the migration tool wraps each file in a transaction."],
    concept_ids: ["transactional-ddl"],
  }],
  concepts: [{
    id: "transactional-ddl",
    name: "Transactional DDL",
    explanation: "Postgres can run schema changes inside a transaction.",
    why_it_matters: "A failed migration leaves no partial schema.",
    question_ids: [QUESTION_ID],
    resources_status: "ok",
    resources: [{
      title: "Transactions",
      publisher: "www.postgresql.org",
      url: "https://www.postgresql.org/docs/current/tutorial-transactions.html",
      what_to_learn: "How BEGIN/COMMIT/ROLLBACK group statements.",
      addresses: "Re-running instead of reverting",
    }],
  }],
  learning_plan: [{
    priority: 1,
    concept_id: "transactional-ddl",
    exercise: "Write a migration that fails halfway and observe the rollback.",
    success_check: "The schema is unchanged after the failure.",
    effort_minutes: 30,
  }],
  final_recommendations: ["Practice explaining failure handling for each migration."],
} satisfies LearningReport;

function propertyNames(schema: unknown, names = new Set<string>()): Set<string> {
  if (Array.isArray(schema)) {
    schema.forEach((item) => propertyNames(item, names));
  } else if (schema !== null && typeof schema === "object") {
    for (const [key, value] of Object.entries(schema)) {
      if (key === "properties" && value && typeof value === "object") {
        Object.keys(value).forEach((name) => names.add(name));
      }
      propertyNames(value, names);
    }
  }
  return names;
}

describe("legacyInterviewReportSchema", () => {
  it("accepts a complete legacy report", () => {
    expect(legacyInterviewReportSchema.parse(report)).toEqual(report);
  });

  it.each([
    ["an overall score", { ...report, score: 4 }],
    ["a numeric category rating", { ...report, categories: [{ ...report.categories[0], rating: 4 }] }],
    ["no categories", { ...report, categories: [] }],
    ["a missing executive summary", { ...report, executive_summary: "" }],
  ])("rejects %s", (_label, value) => {
    expect(legacyInterviewReportSchema.safeParse(value).success).toBe(false);
  });

  it("has no score or rank fields and converts to a strict JSON schema", () => {
    const schema = z.toJSONSchema(legacyInterviewReportSchema) as { additionalProperties: boolean; required: string[] };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toContain("struggled_questions");
    const names = [...propertyNames(schema)];
    expect(names.filter((n) => /score|rank/i.test(n))).toEqual([]);
  });
});

describe("learningReportSchema", () => {
  it("accepts expected and ideal answers, concepts, and a learning plan", () => {
    expect(learningReportSchema.parse(learning)).toEqual(learning);
  });

  it.each([
    ["an overall score", { ...learning, score: 4 }],
    ["an unknown assessment", {
      ...learning,
      question_reviews: [{ ...learning.question_reviews[0], assessment: "mostly_right" }],
    }],
    ["an unknown review key", { ...learning, question_reviews: [{ ...learning.question_reviews[0], extra: "x" }] }],
    ["a non-uuid question id", {
      ...learning,
      question_reviews: [{ ...learning.question_reviews[0], question_message_id: "q1" }],
    }],
    ["no improvement steps", { ...learning, question_reviews: [{ ...learning.question_reviews[0], how_to_improve: [] }] }],
    ["an oversized ideal answer", {
      ...learning,
      question_reviews: [{ ...learning.question_reviews[0], ideal_answer: "x".repeat(6001) }],
    }],
    ["an http resource", {
      ...learning,
      concepts: [{
        ...learning.concepts[0],
        resources: [{ ...learning.concepts[0]!.resources[0]!, url: "http://example.com/a" }],
      }],
    }],
    ["a javascript resource", {
      ...learning,
      concepts: [{
        ...learning.concepts[0],
        resources: [{ ...learning.concepts[0]!.resources[0]!, url: "javascript:alert(1)" }],
      }],
    }],
    ["a malformed concept id", { ...learning, concepts: [{ ...learning.concepts[0], id: "Not An Id" }] }],
    ["the wrong version", { ...learning, report_version: 3 }],
  ])("rejects %s", (_label, value) => {
    expect(learningReportSchema.safeParse(value).success).toBe(false);
  });

  it("has no score or rank fields", () => {
    const names = [...propertyNames(z.toJSONSchema(learningReportSchema))];
    expect(names.filter((n) => /score|rank/i.test(n))).toEqual([]);
  });
});

describe("storedInterviewReportSchema", () => {
  it("parses both versions and tells them apart", () => {
    const legacy = storedInterviewReportSchema.parse(report);
    const v2 = storedInterviewReportSchema.parse(learning);
    expect(isLearningReport(legacy)).toBe(false);
    expect(isLearningReport(v2)).toBe(true);
    expect(v2).toEqual(learning);
  });

  it("does not accept a legacy report with learning fields mixed in", () => {
    expect(storedInterviewReportSchema.safeParse({ ...report, concepts: [] }).success).toBe(false);
  });
});

describe("interviewReportResponseSchema", () => {
  it("accepts each state", () => {
    expect(interviewReportResponseSchema.parse({ status: "pending" })).toEqual({ status: "pending" });
    expect(interviewReportResponseSchema.parse({ status: "failed", error_code: "ai_unavailable" }).status).toBe("failed");
    const ready = { status: "ready", report, generated_at: "2026-10-05T12:00:00.000Z" };
    expect(interviewReportResponseSchema.parse(ready)).toEqual(ready);
    const readyV2 = { status: "ready", report: learning, generated_at: "2026-10-05T12:00:00.000Z" };
    expect(interviewReportResponseSchema.parse(readyV2)).toEqual(readyV2);
  });

  it("rejects a ready response without a report and unknown failure codes", () => {
    expect(interviewReportResponseSchema.safeParse({ status: "ready" }).success).toBe(false);
    expect(interviewReportResponseSchema.safeParse({ status: "failed", error_code: "boom" }).success).toBe(false);
  });

  it("adds the report API error codes", () => {
    expect(apiErrorCodeSchema.safeParse("interview_not_completed").success).toBe(true);
    expect(apiErrorCodeSchema.safeParse("report_not_retryable").success).toBe(true);
  });
});
