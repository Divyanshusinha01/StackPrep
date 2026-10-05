import { describe, expect, it } from "vitest";
import { z } from "zod";
import { apiErrorCodeSchema } from "./github.ts";
import { interviewReportResponseSchema, interviewReportSchema } from "./reports.ts";

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
};

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

describe("interviewReportSchema", () => {
  it("accepts a complete report", () => {
    expect(interviewReportSchema.parse(report)).toEqual(report);
  });

  it.each([
    ["an overall score", { ...report, score: 4 }],
    ["an expected answer on a struggled question", {
      ...report,
      struggled_questions: [{ ...report.struggled_questions[0], expected_answer: "Use a down migration." }],
    }],
    ["a numeric category rating", { ...report, categories: [{ ...report.categories[0], rating: 4 }] }],
    ["no categories", { ...report, categories: [] }],
    ["a missing executive summary", { ...report, executive_summary: "" }],
  ])("rejects %s", (_label, value) => {
    expect(interviewReportSchema.safeParse(value).success).toBe(false);
  });

  it("has no score, rank, or answer fields and converts to a strict JSON schema", () => {
    const schema = z.toJSONSchema(interviewReportSchema) as { additionalProperties: boolean; required: string[] };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toContain("struggled_questions");
    const names = [...propertyNames(schema)];
    expect(names.filter((n) => /score|rank|answer|correct|expected/i.test(n))).toEqual([]);
  });
});

describe("interviewReportResponseSchema", () => {
  it("accepts each state", () => {
    expect(interviewReportResponseSchema.parse({ status: "pending" })).toEqual({ status: "pending" });
    expect(interviewReportResponseSchema.parse({ status: "failed", error_code: "ai_unavailable" }).status).toBe("failed");
    const ready = { status: "ready", report, generated_at: "2026-10-05T12:00:00.000Z" };
    expect(interviewReportResponseSchema.parse(ready)).toEqual(ready);
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
