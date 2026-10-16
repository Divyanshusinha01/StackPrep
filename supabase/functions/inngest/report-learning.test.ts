import { assert, assertEquals, assertThrows } from "@std/assert";
import { AIInvalidOutputError } from "../_shared/ai/provider.ts";
import {
  assessAnswer,
  evaluatedQuestions,
  hydrateLearningReport,
  type LearningReportModelOutput,
  learningReportModelSchema,
} from "./report-learning.ts";
import type { ReportContext, ReportEvaluation } from "./report-store.ts";

const Q = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const SECRET = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";

function evaluation(n: number, score: number | null, rating = "developing"): ReportEvaluation {
  return {
    message_id: Q(n),
    category: "general",
    score,
    rating,
    strengths: [],
    gaps: [`gap ${n}`],
    repo_evidence: [`src/f${n}.ts`],
    discrepancy: false,
  };
}

function context(extra: Partial<ReportContext> = {}): ReportContext {
  return {
    messages: [
      { id: Q(1), sequence: 1, role: "ai", content: "Question one?" },
      { id: "a1", sequence: 2, role: "user", content: "First part." },
      { id: "s1", sequence: 3, role: "system", content: "noise" },
      { id: "a1b", sequence: 4, role: "user", content: `Second part, key ${SECRET}.` },
      { id: Q(2), sequence: 5, role: "ai", content: "Question two?" },
      { id: Q(3), sequence: 6, role: "ai", content: "Question three?" },
      { id: "a3", sequence: 7, role: "user", content: "Answer three." },
      { id: Q(4), sequence: 8, role: "ai", content: "Question four?" },
      { id: "a4", sequence: 9, role: "user", content: "Answer four." },
    ],
    evaluations: [evaluation(1, 5), evaluation(2, 4), evaluation(3, 3), evaluation(4, 1)],
    evidence: [],
    memory: [],
    coverage: [],
    prior: [],
    ...extra,
  };
}

function review(id: string, extra: Partial<LearningReportModelOutput["question_reviews"][number]> = {}) {
  return {
    question_message_id: id,
    expected_answer: "Reference.",
    ideal_answer: "Ideal.",
    factual_errors: [],
    missing_concepts: [],
    communication: [],
    valid_alternatives: [],
    how_to_improve: ["Practice."],
    concept_ids: ["caching"],
    ...extra,
  };
}

function output(extra: Partial<LearningReportModelOutput> = {}): LearningReportModelOutput {
  return {
    executive_summary: "Summary.",
    categories: [{ name: "General", rating: "developing", narrative: "Narrative." }],
    strengths: [],
    gaps: [],
    interview_evidence: [],
    repository_evidence: [],
    areas_to_improve: [],
    question_reviews: [review(Q(1)), review(Q(2)), review(Q(3)), review(Q(4))],
    concepts: [{
      id: "caching",
      name: "HTTP caching",
      explanation: "How caches store responses.",
      why_it_matters: "Latency.",
      question_ids: [Q(1), "not-a-question"],
      search_query: "http caching headers",
    }],
    learning_plan: [
      { priority: 3, concept_id: "unknown", exercise: "General drill.", success_check: "Done.", effort_minutes: 10 },
      { priority: 1, concept_id: "caching", exercise: "Cache drill.", success_check: "Hit.", effort_minutes: 20 },
    ],
    final_recommendations: ["Next."],
    ...extra,
  };
}

Deno.test("assessment follows the stored evaluation and whether the candidate answered", () => {
  assertEquals(assessAnswer(5, "strong", true), "correct");
  assertEquals(assessAnswer(4, "proficient", true), "correct");
  assertEquals(assessAnswer(3, "developing", true), "partially_correct");
  assertEquals(assessAnswer(2, "weak", true), "incorrect");
  assertEquals(assessAnswer(1, "weak", true), "incorrect");
  assertEquals(assessAnswer(5, "strong", false), "unanswered");
  assertEquals(assessAnswer(null, "insufficient_evidence", true), "partially_correct");
  assertEquals(assessAnswer(null, "strong", true), "correct");
  assertEquals(assessAnswer(null, "weak", true), "incorrect");
  assertEquals(assessAnswer(null, null, true), "partially_correct");
});

Deno.test("evaluated questions collect candidate turns up to the next interviewer turn", () => {
  const questions = evaluatedQuestions(context());
  assertEquals(questions.map((q) => [q.question.id, q.answer.map((a) => a.id)]), [
    [Q(1), ["a1", "a1b"]],
    [Q(2), []],
    [Q(3), ["a3"]],
    [Q(4), ["a4"]],
  ]);
});

Deno.test("the latest evaluation for a question wins", () => {
  const questions = evaluatedQuestions(context({ evaluations: [evaluation(1, 1), evaluation(1, 5)] }));
  assertEquals(questions.length, 1);
  assertEquals(questions[0].evaluation.score, 5);
});

Deno.test("hydration fills transcript fields verbatim and derives every assessment", () => {
  const { report, searches } = hydrateLearningReport(output(), context());
  assertEquals(report.question_reviews.map((r) => [r.question, r.assessment]), [
    ["Question one?", "correct"],
    ["Question two?", "unanswered"],
    ["Question three?", "partially_correct"],
    ["Question four?", "incorrect"],
  ]);
  const first = report.question_reviews[0];
  assertEquals(first.candidate_answer, "First part.\n\nSecond part, key [REDACTED_SECRET].");
  assert(!JSON.stringify(report).includes(SECRET), "secrets in the transcript are scrubbed");
  assertEquals(first.repository_area, "src/f1.ts");
  assertEquals(first.evaluator_gaps, ["gap 1"]);
  assertEquals(report.question_reviews[1].candidate_answer, "");
  assertEquals(searches, [{ concept_id: "caching", name: "HTTP caching", query: "http caching headers" }]);
  assertEquals(report.concepts[0].question_ids, [Q(1)], "unknown question ids are dropped");
  assertEquals(report.concepts[0].resources_status, "not_attempted");
  assertEquals(report.learning_plan.map((p) => [p.priority, p.concept_id]), [[1, "caching"], [2, ""]]);
  assertEquals(report.struggled_questions, []);
});

Deno.test("reviews for invented or duplicate question ids are dropped", () => {
  const { report } = hydrateLearningReport(
    output({ question_reviews: [review("made-up-id"), review(Q(3)), review(Q(3), { expected_answer: "dup" })] }),
    context(),
  );
  assertEquals(report.question_reviews.length, 1);
  assertEquals(report.question_reviews[0].expected_answer, "Reference.");
});

Deno.test("model output cannot carry its own assessment or candidate answer", () => {
  const forged = { ...output(), question_reviews: [{ ...review(Q(4)), assessment: "correct", candidate_answer: "I said X" }] };
  assertEquals(learningReportModelSchema.safeParse(forged).success, false);
});

Deno.test("at most ten reviews are kept, weakest first, shown in transcript order", () => {
  const messages = Array.from({ length: 12 }, (_, i) => [
    { id: `10000000-0000-4000-8000-0000000000${String(i).padStart(2, "0")}`, sequence: i * 2 + 1, role: "ai" as const, content: `Q${i}?` },
    { id: `ans${i}`, sequence: i * 2 + 2, role: "user" as const, content: `A${i}` },
  ]).flat();
  const ids = messages.filter((m) => m.role === "ai").map((m) => m.id);
  const evaluations = ids.map((id, i) => ({ ...evaluation(1, i < 2 ? 5 : 1), message_id: id }));
  const { report } = hydrateLearningReport(
    output({ question_reviews: ids.map((id) => review(id)), concepts: [] }),
    context({ messages, evaluations }),
  );
  assertEquals(report.question_reviews.length, 10);
  assert(report.question_reviews.every((r) => r.assessment === "incorrect"), "correct answers are dropped first");
  assertEquals(report.question_reviews.map((r) => r.question), ids.slice(2).map((_, i) => `Q${i + 2}?`));
});

Deno.test("concept ids are normalized and deduplicated, and review references follow", () => {
  const { report } = hydrateLearningReport(
    output({
      question_reviews: [review(Q(1), { concept_ids: ["HTTP Caching!", "missing"] })],
      concepts: [
        { ...output().concepts[0], id: "HTTP Caching!" },
        { ...output().concepts[0], id: "HTTP Caching!", name: "HTTP caching" },
      ],
    }),
    context(),
  );
  assertEquals(report.concepts.map((c) => c.id), ["http-caching"]);
  assertEquals(report.question_reviews[0].concept_ids, ["http-caching"]);
});

Deno.test("an empty required field after scrubbing invalidates the report", () => {
  assertThrows(
    () => hydrateLearningReport(output({ executive_summary: "   " }), context()),
    AIInvalidOutputError,
  );
});
