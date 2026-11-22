import { isLearningReport, type ReportRating, type StoredInterviewReport } from "./reports.ts";

// Progress across the completed interviews of one workspace (PRD sections 23-24). It is derived
// only from saved reports: category ratings, strengths, gaps and the assessments of reviewed
// questions. It never reads or shows the internal coverage map or the plan (PRD sections 7, 25).

export interface ProgressInput {
  interview_id: string;
  interview_number: number;
  /** When the report was generated (ISO timestamp). */
  generated_at: string;
  report: StoredInterviewReport;
}

export interface ProgressCategory {
  name: string;
  rating: ReportRating;
}

export interface ProgressAssessments {
  correct: number;
  partially_correct: number;
  incorrect: number;
  unanswered: number;
}

export interface ProgressInterview {
  interview_id: string;
  interview_number: number;
  generated_at: string;
  categories: ProgressCategory[];
  strengths: number;
  gaps: number;
  /** Null for a report generated before question reviews existed. */
  assessments: ProgressAssessments | null;
}

export type ProgressTrend = "improved" | "declined" | "steady";

export interface ProgressCategoryTrend {
  name: string;
  /** Oldest to newest; only interviews that rated this category with evidence. */
  ratings: { interview_number: number; rating: ReportRating }[];
  /** Null with fewer than two rated interviews. */
  trend: ProgressTrend | null;
}

export interface WorkspaceProgress {
  interviews: ProgressInterview[];
  trends: ProgressCategoryTrend[];
}

const RATING_RANK: Record<ReportRating, number | null> = {
  weak: 1,
  developing: 2,
  proficient: 3,
  strong: 4,
  insufficient_evidence: null,
};

const categoryKey = (name: string) => name.trim().toLowerCase();

function assessmentsOf(report: StoredInterviewReport): ProgressAssessments | null {
  if (!isLearningReport(report)) {
    return null;
  }
  const counts: ProgressAssessments = { correct: 0, partially_correct: 0, incorrect: 0, unanswered: 0 };
  for (const review of report.question_reviews) {
    counts[review.assessment] += 1;
  }
  return counts;
}

/**
 * Oldest interview first. Categories are matched by name ignoring case, since the interviewer may
 * add repository-specific ones; a category seen in a single interview has no trend. There is no
 * overall score and no ranking: only a category's own movement between interviews.
 */
export function deriveWorkspaceProgress(inputs: readonly ProgressInput[]): WorkspaceProgress {
  const ordered = [...inputs].sort((a, b) => a.interview_number - b.interview_number);

  const interviews: ProgressInterview[] = ordered.map((input) => ({
    interview_id: input.interview_id,
    interview_number: input.interview_number,
    generated_at: input.generated_at,
    categories: input.report.categories.map(({ name, rating }) => ({ name, rating })),
    strengths: input.report.strengths.length,
    gaps: input.report.gaps.length,
    assessments: assessmentsOf(input.report),
  }));

  const byCategory = new Map<string, ProgressCategoryTrend>();
  for (const interview of interviews) {
    for (const { name, rating } of interview.categories) {
      if (RATING_RANK[rating] === null) {
        continue;
      }
      const key = categoryKey(name);
      const entry = byCategory.get(key) ?? { name, ratings: [], trend: null };
      // A repeated name inside one report keeps its first rating.
      if (!entry.ratings.some((r) => r.interview_number === interview.interview_number)) {
        entry.ratings.push({ interview_number: interview.interview_number, rating });
      }
      byCategory.set(key, entry);
    }
  }

  const trends = [...byCategory.values()].map((entry): ProgressCategoryTrend => {
    const first = entry.ratings[0];
    const last = entry.ratings[entry.ratings.length - 1];
    const from = first ? RATING_RANK[first.rating] : null;
    const to = last ? RATING_RANK[last.rating] : null;
    if (entry.ratings.length < 2 || from === null || to === null) {
      return entry;
    }
    return { ...entry, trend: to > from ? "improved" : to < from ? "declined" : "steady" };
  });
  return { interviews, trends };
}
