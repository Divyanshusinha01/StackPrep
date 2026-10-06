import type { InterviewReport } from "@stackprep/shared";

/** A valid report (interviewReportSchema), as the report job would store it. */
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
