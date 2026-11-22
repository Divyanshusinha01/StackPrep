import { ArrowDownRight, ArrowRight, ArrowUpRight, TrendingUp } from "lucide-react";
import type { ProgressCategoryTrend, ProgressInterview, ProgressTrend, WorkspaceProgress } from "@stackprep/shared";
import { StatusChip } from "@/components/app/status-chip";
import { Surface } from "@/components/app/surface";
import { RATING_LABELS, RATING_TONES } from "@/components/app/report-view";

const TREND_COPY: Record<ProgressTrend, { label: string; Icon: typeof ArrowRight; className: string }> = {
  improved: { label: "Improved", Icon: ArrowUpRight, className: "text-success" },
  declined: { label: "Needs attention", Icon: ArrowDownRight, className: "text-warning" },
  steady: { label: "Steady", Icon: ArrowRight, className: "text-muted-foreground" },
};

function CategoryRow({ trend }: { trend: ProgressCategoryTrend }) {
  const copy = trend.trend ? TREND_COPY[trend.trend] : null;
  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="truncate text-sm font-medium">{trend.name}</span>
        {copy ? (
          <span className={`inline-flex items-center gap-1 text-xs font-medium ${copy.className}`}>
            <copy.Icon className="size-3.5" aria-hidden />
            {copy.label}
          </span>
        ) : null}
      </div>
      <ol className="flex flex-wrap items-center gap-1.5" aria-label={`${trend.name} ratings by interview`}>
        {trend.ratings.map(({ interview_number: number, rating }, index) => (
          <li key={number} className="flex items-center gap-1.5">
            {index > 0 ? <ArrowRight className="size-3 text-muted-foreground/60" aria-hidden /> : null}
            <StatusChip tone={RATING_TONES[rating]}>
              <span className="font-mono tabular-nums">#{number}</span> {RATING_LABELS[rating]}
            </StatusChip>
          </li>
        ))}
      </ol>
    </li>
  );
}

function InterviewSummary({ interview }: { interview: ProgressInterview }) {
  const a = interview.assessments;
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2.5 text-xs text-muted-foreground sm:px-5">
      <span className="font-mono font-medium text-foreground tabular-nums">Interview {interview.interview_number}</span>
      <span className="tabular-nums">
        {interview.strengths} {interview.strengths === 1 ? "strength" : "strengths"} · {interview.gaps}{" "}
        {interview.gaps === 1 ? "gap" : "gaps"}
        {a
          ? ` · ${a.correct} correct, ${a.partially_correct} partial, ${a.incorrect} incorrect${a.unanswered ? `, ${a.unanswered} unanswered` : ""}`
          : ""}
      </span>
    </li>
  );
}

/**
 * How the user's saved reports change across the workspace's interviews. Built only from report
 * content: it has no overall score, no ranking, and never shows the internal coverage map.
 */
export function WorkspaceProgressSection({ progress }: { progress: WorkspaceProgress }) {
  if (progress.interviews.length === 0) {
    return null;
  }
  const comparable = progress.interviews.length >= 2;
  return (
    <section className="mt-10" aria-labelledby="workspace-progress">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="workspace-progress" className="flex items-center gap-2 font-display text-lg font-semibold tracking-tight">
          <TrendingUp className="size-4 text-brand" aria-hidden />
          Progress
        </h2>
        <span className="font-mono text-xs text-muted-foreground tabular-nums">
          {progress.interviews.length} {progress.interviews.length === 1 ? "report" : "reports"}
        </span>
      </div>
      <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
        {comparable
          ? "How each category was rated in your saved reports, oldest to newest. Every interview is a fresh evaluation, so this shows movement, not a score."
          : "Complete another interview to see how each category changes between reports."}
      </p>
      <Surface className="mt-4 overflow-hidden">
        <ul className="divide-y" data-testid="progress-categories">
          {progress.trends.length > 0 ? (
            progress.trends.map((trend) => <CategoryRow key={trend.name.toLowerCase()} trend={trend} />)
          ) : (
            <li className="px-4 py-3 text-sm text-muted-foreground sm:px-5">
              No category had enough evidence to compare yet.
            </li>
          )}
        </ul>
        <ul className="divide-y border-t bg-panel/40" data-testid="progress-interviews">
          {progress.interviews.map((interview) => (
            <InterviewSummary key={interview.interview_id} interview={interview} />
          ))}
        </ul>
      </Surface>
    </section>
  );
}
