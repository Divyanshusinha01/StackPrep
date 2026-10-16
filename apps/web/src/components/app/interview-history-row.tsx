import Link from "next/link";
import { FileText, Loader2, Play, ScrollText, ShieldAlert } from "lucide-react";
import { DeleteInterviewButton } from "@/components/app/delete-interview-button";
import { InterviewStatusBadge } from "@/components/app/interview-status";
import { Button } from "@/components/ui/button";
import type { InterviewHistoryEntry, ReportAvailability } from "@/lib/api";

const dateTimeFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
const timeFormat = new Intl.DateTimeFormat("en", { timeStyle: "short", timeZone: "UTC" });

const REPORT_LABELS: Record<Exclude<ReportAvailability, "none">, string> = {
  ready: "Report",
  generating: "Report generating…",
  failed: "Report unavailable",
};

const ENDED = new Set(["completed", "terminated", "failed"]);

/** Message for the `delete_error` query param set by the delete action, or null when absent. */
export function deleteInterviewErrorMessage(value: string | string[] | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  if (value === "interview_not_ended") {
    return "Only ended interviews can be deleted.";
  }
  if (value === "interview_not_found") {
    return "That interview no longer exists.";
  }
  return "Could not delete the interview. Try again.";
}

/**
 * One interview in a history list: number, status, date/time, report or transcript link, and a
 * delete button once it has ended. `returnTo` is the page to come back to after deleting.
 */
export function InterviewHistoryRow({ interview, returnTo }: { interview: InterviewHistoryEntry; returnTo: string }) {
  const reportHref = `/interviews/${interview.id}/report`;
  const ended = ENDED.has(interview.status);
  const integrityTerminated = interview.status === "terminated" && interview.termination_reason === "integrity_violation";
  return (
    <li className="flex flex-col gap-3 px-4 py-3.5 text-sm transition-colors hover:bg-panel-raised/50 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:px-5">
      <div className="flex min-w-0 flex-1 items-center gap-3.5">
        <span
          aria-hidden
          className="grid size-9 shrink-0 place-items-center rounded-lg border border-border-strong/60 bg-background/60 font-mono text-xs font-semibold text-muted-foreground tabular-nums"
        >
          #{interview.interview_number}
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <Link
              href={ended ? reportHref : `/interviews/${interview.id}`}
              className="focus-ring rounded-sm font-display font-medium text-foreground hover:text-brand hover:underline"
            >
              Interview {interview.interview_number}
            </Link>
            <InterviewStatusBadge status={interview.status} terminationReason={interview.termination_reason} />
            {integrityTerminated ? (
              <span className="inline-flex items-center gap-1 text-xs font-medium text-danger">
                <ShieldAlert className="size-3.5" aria-hidden />
                Ended for integrity
              </span>
            ) : null}
          </div>
          <p className="mt-1 font-mono text-[11px] text-muted-foreground tabular-nums">
            <time dateTime={interview.created_at}>{dateTimeFormat.format(new Date(interview.created_at))} UTC</time>
            {interview.pause === "expired" ? <span className="text-warning"> · Pause expired</span> : null}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 pl-12 sm:pl-0">
        {interview.pause && interview.pause !== "expired" ? (
          <Button asChild size="sm">
            <Link href={`/interviews/${interview.id}`}>
              <Play aria-hidden />
              Resume by {timeFormat.format(new Date(interview.pause.resumeBy))} UTC
            </Link>
          </Button>
        ) : null}
        {interview.report !== "none" ? (
          <Button asChild variant={interview.report === "ready" ? "secondary" : "ghost"} size="sm">
            <Link href={reportHref}>
              {interview.report === "generating" ? (
                <Loader2 className="motion-safe:animate-spin" aria-hidden />
              ) : (
                <FileText aria-hidden />
              )}
              {REPORT_LABELS[interview.report]}
            </Link>
          </Button>
        ) : ended ? (
          <Button asChild variant="ghost" size="sm">
            <Link href={`${reportHref}#transcript`}>
              <ScrollText aria-hidden />
              Transcript
            </Link>
          </Button>
        ) : null}
        {ended ? (
          <DeleteInterviewButton
            interviewId={interview.id}
            interviewNumber={interview.interview_number}
            returnTo={returnTo}
          />
        ) : null}
      </div>
    </li>
  );
}
