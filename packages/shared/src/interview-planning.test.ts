import { describe, expect, it } from "vitest";
import { z } from "zod";
import { interviewPlanningOutputSchema } from "./interview-planning.ts";

const area = (id: string) => ({
  id,
  name: id,
  priority: "high",
  rationale: "Central to the repository",
  topics: ["Request lifecycle"],
  repo_evidence: ["src/server.ts"],
  status: "not_started",
});

const validOutput = {
  coverage_map: { areas: [area("architecture"), area("backend"), area("testing")] },
  plan: {
    summary: "Walk through the architecture, then the backend, then testing.",
    phases: [
      { title: "Architecture", coverage_area_ids: ["architecture"], goals: ["Explain the system"], minutes: 10 },
      { title: "Backend", coverage_area_ids: ["backend", "testing"], goals: ["Trace a request"], minutes: 15 },
    ],
    opening_question: "Walk me through what happens when a request hits the server.",
  },
  strategy: {
    difficulty: "intermediate",
    focus_area_ids: ["backend"],
    avoid_repeating: [],
    follow_up_style: "Probe trade-offs behind each decision",
    notes: [],
  },
};

describe("interviewPlanningOutputSchema", () => {
  it("accepts a complete plan", () => {
    expect(interviewPlanningOutputSchema.parse(validOutput)).toEqual(validOutput);
  });

  it.each([
    ["too few coverage areas", { ...validOutput, coverage_map: { areas: [area("architecture")] } }],
    ["an invalid area id", { ...validOutput, coverage_map: { areas: [area("Arch!"), area("b"), area("c")] } }],
    ["a missing strategy", { coverage_map: validOutput.coverage_map, plan: validOutput.plan }],
    ["unknown keys", { ...validOutput, score: 5 }],
    ["an unknown difficulty", { ...validOutput, strategy: { ...validOutput.strategy, difficulty: "expert" } }],
  ])("rejects %s", (_label, value) => {
    expect(interviewPlanningOutputSchema.safeParse(value).success).toBe(false);
  });

  it("converts to a JSON schema with every property required and no extra properties", () => {
    const schema = z.toJSONSchema(interviewPlanningOutputSchema) as {
      required: string[];
      additionalProperties: boolean;
    };
    expect(schema.required).toEqual(["coverage_map", "plan", "strategy"]);
    expect(schema.additionalProperties).toBe(false);
  });
});
