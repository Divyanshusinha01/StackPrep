import { describe, expect, it } from "vitest";
import { formatInterviewCost } from "./interview-costs.ts";
import { shareTokenSchema } from "./report-shares.ts";
import type { ReportRating, StoredInterviewReport } from "./reports.ts";
import { deriveWorkspaceProgress, type ProgressInput } from "./workspace-progress.ts";

function legacy(categories: Record<string, ReportRating>, extra: Partial<StoredInterviewReport> = {}) {
  return {
    executive_summary: "Summary",
    categories: Object.entries(categories).map(([name, rating]) => ({ name, rating, narrative: "n" })),
    strengths: ["a", "b"],
    gaps: ["c"],
    interview_evidence: [],
    repository_evidence: [],
    areas_to_improve: [],
    struggled_questions: [],
    ...extra,
  } as StoredInterviewReport;
}

const input = (number: number, report: StoredInterviewReport): ProgressInput => ({
  interview_id: `00000000-0000-4000-8000-00000000000${number}`,
  interview_number: number,
  generated_at: `2026-11-0${number}T10:00:00.000Z`,
  report,
});

describe("deriveWorkspaceProgress", () => {
  it("orders interviews oldest first and counts strengths and gaps", () => {
    const progress = deriveWorkspaceProgress([
      input(2, legacy({ Architecture: "strong" })),
      input(1, legacy({ Architecture: "developing" })),
    ]);
    expect(progress.interviews.map((i) => i.interview_number)).toEqual([1, 2]);
    expect(progress.interviews[0]).toMatchObject({ strengths: 2, gaps: 1, assessments: null });
  });

  it("reports the movement of a category between its first and latest rating", () => {
    const progress = deriveWorkspaceProgress([
      input(1, legacy({ Security: "weak", Testing: "strong", Backend: "proficient" })),
      input(2, legacy({ Security: "developing", Testing: "developing", Backend: "proficient" })),
      input(3, legacy({ Security: "proficient", Testing: "weak", Backend: "proficient" })),
    ]);
    const trend = (name: string) => progress.trends.find((t) => t.name === name)?.trend;
    expect(trend("Security")).toBe("improved");
    expect(trend("Testing")).toBe("declined");
    expect(trend("Backend")).toBe("steady");
  });

  it("matches categories case-insensitively and ignores insufficient evidence", () => {
    const progress = deriveWorkspaceProgress([
      input(1, legacy({ Database: "insufficient_evidence" })),
      input(2, legacy({ database: "proficient" })),
    ]);
    expect(progress.trends).toHaveLength(1);
    expect(progress.trends[0]?.ratings).toEqual([{ interview_number: 2, rating: "proficient" }]);
    expect(progress.trends[0]?.trend).toBeNull();
  });

  it("gives a category seen once no trend, and an empty workspace no rows", () => {
    expect(deriveWorkspaceProgress([input(1, legacy({ Architecture: "strong" }))]).trends[0]?.trend).toBeNull();
    expect(deriveWorkspaceProgress([])).toEqual({ interviews: [], trends: [] });
  });

  it("tallies question assessments for learning reports only", () => {
    const learning = {
      ...legacy({ Architecture: "strong" }),
      report_version: 2,
      question_reviews: [
        { assessment: "correct" },
        { assessment: "incorrect" },
        { assessment: "incorrect" },
        { assessment: "unanswered" },
      ],
    } as unknown as StoredInterviewReport;
    const [interview] = deriveWorkspaceProgress([input(1, learning)]).interviews;
    expect(interview?.assessments).toEqual({ correct: 1, partially_correct: 0, incorrect: 2, unanswered: 1 });
  });

  it("exposes no overall score, ranking or coverage information", () => {
    const [interview] = deriveWorkspaceProgress([input(1, legacy({ Architecture: "strong" }))]).interviews;
    expect(Object.keys(interview ?? {}).sort()).toEqual([
      "assessments",
      "categories",
      "gaps",
      "generated_at",
      "interview_id",
      "interview_number",
      "strengths",
    ]);
  });
});

describe("formatInterviewCost", () => {
  it("formats dollars and flags tiny non-zero amounts", () => {
    expect(formatInterviewCost(0)).toBe("$0.00");
    expect(formatInterviewCost(0.004)).toBe("<$0.01");
    expect(formatInterviewCost(1.5)).toBe("$1.50");
  });
});

describe("shareTokenSchema", () => {
  it("accepts only 43 base64url characters", () => {
    expect(shareTokenSchema.safeParse("A".repeat(43)).success).toBe(true);
    expect(shareTokenSchema.safeParse("A".repeat(42)).success).toBe(false);
    expect(shareTokenSchema.safeParse(`${"A".repeat(42)}=`).success).toBe(false);
    expect(shareTokenSchema.safeParse(`${"A".repeat(42)}/`).success).toBe(false);
  });
});
