import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import type { ReportErrorCode } from "@stackprep/shared";
import { AppShell } from "@/components/app/app-shell";
import { InterviewStatusBadge } from "@/components/app/interview-status";
import { InterviewTranscript } from "@/components/app/interview-transcript";
import { Notice } from "@/components/app/notice";
import { ReportPending } from "@/components/app/report-pending";
import { ReportView } from "@/components/app/report-view";
import { SubmitButton } from "@/components/app/submit-button";
import { Button } from "@/components/ui/button";
import { getInterview, getInterviewReport, getInterviewTranscript } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { retryReport } from "./actions";

export const metadata: Metadata = {
  title: "Interview report · StackPrep",
  robots: { index: false },
};

const FAILURE_MESSAGES: Record<ReportErrorCode, string> = {
  transcript_unavailable: "No answers were recorded in this interview, so there is nothing to report on.",
  ai_rate_limited: "The report service was busy.",
  ai_unavailable: "The report service was unavailable.",
  ai_invalid_output: "The report could not be generated.",
  enqueue_failed: "The report could not be started.",
  internal_error: "Something went wrong while generating the report.",
};

const dateTimeFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

function RetryForm({ interviewId }: { interviewId: string }) {
  return (
    <form action={retryReport}>
      <input type="hidden" name="interview_id" value={interviewId} />
      <SubmitButton variant="outline" size="sm" pendingLabel="Retrying…">
        Retry report
      </SubmitButton>
    </form>
  );
}

async function ReportBody({ interviewId, retryFailed }: { interviewId: string; retryFailed: boolean }) {
  const result = await getInterviewReport(interviewId);
  if (!result.ok) {
    return (
      <Notice tone="error">
        <span>Could not load the report.</span>
        <Button asChild variant="outline" size="sm">
          <Link href={`/interviews/${interviewId}/report`}>Reload</Link>
        </Button>
      </Notice>
    );
  }
  const state = result.data;
  if (state.status === "pending") {
    return <ReportPending />;
  }
  if (state.status === "failed") {
    return (
      <Notice tone="error">
        <span>
          {retryFailed ? "The retry could not be started. " : ""}
          {FAILURE_MESSAGES[state.error_code]}
        </span>
        {state.error_code !== "transcript_unavailable" ? <RetryForm interviewId={interviewId} /> : null}
      </Notice>
    );
  }
  return (
    <>
      <p className="mt-2 text-xs text-muted-foreground">
        Generated {dateTimeFormat.format(new Date(state.generated_at))} UTC
      </p>
      <ReportView report={state.report} />
    </>
  );
}

export default async function InterviewReportPage({ params, searchParams }: PageProps<"/interviews/[id]/report">) {
  const { id } = await params;
  const query = await searchParams;
  const user = await requireUser(`/interviews/${encodeURIComponent(id)}/report`);
  const interview = await getInterview(id);
  if (!interview) {
    notFound();
  }
  const transcript = await getInterviewTranscript(interview.id);
  const completed = interview.status === "completed";

  return (
    <AppShell user={user}>
      <Link
        href={`/workspaces/${interview.workspace_id}`}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        <span className="font-mono">{interview.repository_full_name}</span>
      </Link>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <h1 className="font-display text-2xl font-semibold tracking-tight">Interview {interview.interview_number} report</h1>
        <InterviewStatusBadge status={interview.status} terminationReason={interview.termination_reason} />
      </div>

      {completed ? (
        <ReportBody interviewId={interview.id} retryFailed={typeof query.retry_error === "string"} />
      ) : (
        <Notice tone="info">
          <span>
            {interview.status === "terminated" || interview.status === "failed"
              ? "This interview ended before completion, so no report was generated."
              : "This interview has not been completed yet, so there is no report."}
          </span>
          {interview.status === "created" || interview.status === "in_progress" || interview.status === "paused" ? (
            <Button asChild variant="outline" size="sm">
              <Link href={`/interviews/${interview.id}`}>Go to interview</Link>
            </Button>
          ) : null}
        </Notice>
      )}

      <section id="transcript" className="mt-10 scroll-mt-20" aria-labelledby="report-transcript">
        <h2 id="report-transcript" className="font-display text-lg font-semibold">
          Full interview transcript
        </h2>
        <InterviewTranscript entries={transcript} />
      </section>
    </AppShell>
  );
}
