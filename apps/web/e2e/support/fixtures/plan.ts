import type { InterviewPlanningOutput } from "@stackprep/shared";

/** A valid planning output (interviewPlanningOutputSchema), as the planning job would write it. */
export const PLANNING_OUTPUT: InterviewPlanningOutput = {
  coverage_map: {
    areas: [
      {
        id: "architecture",
        name: "Architecture",
        priority: "high",
        rationale: "The repository splits a web app from serverless functions.",
        topics: ["Service boundaries", "Data flow"],
        repo_evidence: ["src/server/index.ts"],
        status: "not_started",
      },
      {
        id: "data_model",
        name: "Data model",
        priority: "medium",
        rationale: "Persistence decisions shape the rest of the system.",
        topics: ["Schema design"],
        repo_evidence: ["db/schema.sql"],
        status: "not_started",
      },
      {
        id: "testing",
        name: "Testing",
        priority: "low",
        rationale: "The test strategy shows how changes are verified.",
        topics: ["Unit tests"],
        repo_evidence: [],
        status: "not_started",
      },
    ],
  },
  plan: {
    summary: "Walk through the architecture, then the data model and testing.",
    phases: [
      { title: "Architecture", coverage_area_ids: ["architecture"], goals: ["Explain the main components"], minutes: 10 },
      { title: "Data and tests", coverage_area_ids: ["data_model", "testing"], goals: ["Justify the schema"], minutes: 10 },
    ],
    opening_question: "Give me a quick tour of how a request flows through this repository.",
  },
  strategy: {
    difficulty: "intermediate",
    focus_area_ids: ["architecture"],
    avoid_repeating: [],
    follow_up_style: "Ask for concrete file references.",
    notes: [],
  },
};
