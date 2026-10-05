import Link from "next/link";
import { FileText, ShieldAlert } from "lucide-react";
import { InterviewStatusBadge } from "@/components/app/interview-status";
import type { InterviewHistoryEntry, ReportAvailability } from "@/lib/api";

const dateTimeFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

const REPORT_LABELS: Record<Exclude<ReportAvailability, "none">, string> = {
  ready: "Report",
  generating: "Report generating…",
  failed: "Report unavailable",
};

const ENDED = new Set(["completed", "terminated", "failed"]);

/** One interview in a history list: number, status, date/time, report or transcript link. */
export function InterviewHistoryRow({ interview }: { interview: InterviewHistoryEntry }) {
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
        <InterviewStatusBadge status={interview.status} />
      </span>
    </li>
  );
}
