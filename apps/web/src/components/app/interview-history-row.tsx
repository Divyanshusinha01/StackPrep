import Link from "next/link";
import { FileText, Play, ShieldAlert } from "lucide-react";
import { DeleteInterviewButton } from "@/components/app/delete-interview-button";
import { InterviewStatusBadge } from "@/components/app/interview-status";
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
  const integrityTerminated = interview.status === "terminated" && interview.termination_reason === "integrity_violation";
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm">
      <Link href={`/interviews/${interview.id}`} className="font-medium hover:underline">
        Interview {interview.interview_number}
      </Link>
      <time dateTime={interview.created_at} className="text-xs text-muted-foreground">
        {dateTimeFormat.format(new Date(interview.created_at))} UTC
      </time>
      {integrityTerminated ? (
        <span className="inline-flex items-center gap-1 text-xs text-red-300">
          <ShieldAlert className="size-3.5" aria-hidden />
          Ended for integrity
        </span>
      ) : null}
      <span className="ml-auto flex items-center gap-3">
        {interview.pause === "expired" ? (
          <span className="text-xs text-muted-foreground">Pause expired</span>
        ) : interview.pause ? (
          <Link
            href={`/interviews/${interview.id}`}
            className="inline-flex items-center gap-1 text-xs text-foreground hover:underline"
          >
            <Play className="size-3.5" aria-hidden />
            Resume by {timeFormat.format(new Date(interview.pause.resumeBy))} UTC
          </Link>
        ) : null}
        {interview.report !== "none" ? (
          <Link href={reportHref} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <FileText className="size-3.5" aria-hidden />
            {REPORT_LABELS[interview.report]}
          </Link>
        ) : ENDED.has(interview.status) ? (
          <Link href={`${reportHref}#transcript`} className="text-xs text-muted-foreground hover:text-foreground">
            Transcript
          </Link>
        ) : null}
        <InterviewStatusBadge status={interview.status} terminationReason={interview.termination_reason} />
        {ENDED.has(interview.status) ? (
          <DeleteInterviewButton
            interviewId={interview.id}
            interviewNumber={interview.interview_number}
            returnTo={returnTo}
          />
        ) : null}
      </span>
    </li>
  );
}
