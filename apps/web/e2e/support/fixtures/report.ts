import type { InterviewReport, LearningReport, QuestionReview } from "@stackprep/shared";

/** A valid legacy report (legacyInterviewReportSchema), as reports stored before learning reports look. */
export const REPORT: InterviewReport = {
  executive_summary: "The candidate explained the request flow clearly and grounded answers in specific files.",
  categories: [
    {
      name: "Architecture",
      rating: "proficient",
      narrative: "Described the boundary between the web app and the functions with concrete examples.",
    },
    {
      name: "Testing",
      rating: "developing",
      narrative: "Knew where tests live but could not explain how integration paths are covered.",
    },
  ],
  strengths: ["Clear explanation of the request lifecycle"],
  gaps: ["Limited reasoning about failure handling"],
  interview_evidence: [{ category: "Architecture", observation: "Traced a request from the page to the database." }],
  repository_evidence: [{ path: "src/server/index.ts", note: "Entry point discussed during the interview." }],
  areas_to_improve: ["Practice explaining retry and failure paths"],
  struggled_questions: [],
};

function review(n: number, extra: Partial<QuestionReview>): QuestionReview {
  return {
    question_message_id: `00000000-0000-4000-8000-00000000000${n}`,
    question: `Question ${n}?`,
    candidate_answer: `Answer ${n}.`,
    answer_truncated: false,
    assessment: "correct",
    evaluator_rating: "proficient",
    evaluator_strengths: [],
    evaluator_gaps: [],
    repository_area: "src/server/index.ts",
    expected_answer: `Reference answer ${n}.`,
    ideal_answer: `Ideal answer ${n}.`,
    factual_errors: [],
    missing_concepts: [],
    communication: [],
    valid_alternatives: [],
    how_to_improve: [`Improve step ${n}.`],
    concept_ids: [],
    ...extra,
  };
}

/** A valid learning report (learningReportSchema) with every assessment state and resource state. */
export const LEARNING_REPORT: LearningReport = {
  report_version: 2,
  ...REPORT,
  question_reviews: [
    review(1, {
      question: "How does a request reach the database?",
      candidate_answer: "Through the API route, which calls the data layer.",
      assessment: "correct",
      evaluator_strengths: ["Named the route and the data layer"],
    }),
    review(2, {
      question: "What happens when the database call times out?",
      candidate_answer: "The request just fails.",
      assessment: "partially_correct",
      evaluator_rating: "developing",
      missing_concepts: ["Retry with backoff for idempotent reads"],
      communication: ["Did not describe what the user sees"],
      valid_alternatives: ["Fail fast and surface a clear error, if retries are unsafe."],
      concept_ids: ["retries-and-idempotency"],
    }),
    review(3, {
      question: "Why is the job runner safe to retry?",
      candidate_answer: "Because it runs every step again from scratch.",
      assessment: "incorrect",
      evaluator_rating: "weak",
      factual_errors: ["Steps are memoized; completed steps are not re-run."],
      ideal_answer:
        "Each step's result is memoized, so a retry resumes after the last completed step:\n\n```ts\nconst report = await step.run(\"generate\", () => generate());\n```\n\nThe final write is an upsert, so repeating it is harmless.",
      how_to_improve: ["Read how durable steps are replayed.", "Explain why the final write is idempotent."],
      concept_ids: ["retries-and-idempotency", "durable-execution"],
    }),
    review(4, {
      question: "How are database migrations rolled back?",
      candidate_answer: "",
      assessment: "unanswered",
      evaluator_rating: "insufficient_evidence",
      repository_area: "",
    }),
  ],
  concepts: [
    {
      id: "retries-and-idempotency",
      name: "Retries and idempotency",
      explanation: "An idempotent operation has the same effect whether it runs once or many times.",
      why_it_matters: "Retries are only safe when repeating the operation cannot duplicate side effects.",
      question_ids: ["00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003"],
      resources_status: "ok",
      resources: [{
        title: "Idempotent - MDN Web Docs Glossary",
        publisher: "developer.mozilla.org",
        url: "https://developer.mozilla.org/en-US/docs/Glossary/Idempotent",
        what_to_learn: "Which HTTP methods are idempotent and why that matters for retries.",
        addresses: "Retry with backoff for idempotent reads",
      }],
    },
    {
      id: "durable-execution",
      name: "Durable execution",
      explanation: "A durable workflow records each step's result so it can resume after a failure.",
      why_it_matters: "It lets long jobs survive crashes without repeating finished work.",
      question_ids: ["00000000-0000-4000-8000-000000000003"],
      resources_status: "unavailable",
      resources: [],
    },
  ],
  learning_plan: [
    {
      priority: 1,
      concept_id: "durable-execution",
      exercise: "Write a two-step job that fails after the first step, then retry it.",
      success_check: "The first step does not run again on retry.",
      effort_minutes: 45,
    },
    {
      priority: 2,
      concept_id: "retries-and-idempotency",
      exercise: "Add retries with backoff to a read endpoint.",
      success_check: "A transient failure succeeds on the second attempt.",
      effort_minutes: 30,
    },
  ],
  final_recommendations: ["Explain failure paths before the happy path."],
};
