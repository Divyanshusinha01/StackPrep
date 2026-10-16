import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRight } from "lucide-react";
import type { InterviewReportResponse, ReportErrorCode } from "@stackprep/shared";
import { AppShell } from "@/components/app/app-shell";
import { InterviewStatusBadge } from "@/components/app/interview-status";
import { InterviewTranscript } from "@/components/app/interview-transcript";
import { Notice } from "@/components/app/notice";
import { OpenAIKeyNotice } from "@/components/app/openai-key-notice";
import { PageHeader } from "@/components/app/page-header";
import { PrintButton } from "@/components/app/print-button";
import { ReportPending } from "@/components/app/report-pending";
import { ReportToc } from "@/components/app/report-toc";
import { REPORT_SECTIONS, ReportView } from "@/components/app/report-view";
import { SubmitButton } from "@/components/app/submit-button";
import { TrackReportViewed } from "@/components/app/track-report-viewed";
import { TranscriptDisclosure } from "@/components/app/transcript-disclosure";
import { Button } from "@/components/ui/button";
import { type ApiResult, getInterview, getInterviewReport, getInterviewTranscript } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { currentKeySetupCode } from "@/lib/openai-key-gate";
import { isOpenAIKeySetupCode } from "@/lib/openai-key-setup";
import { retryReport } from "./actions";

export const metadata: Metadata = {
  title: "Interview report",
  robots: { index: false },
};

const FAILURE_MESSAGES: Record<ReportErrorCode, string> = {
  transcript_unavailable: "No answers were recorded in this interview, so there is nothing to report on.",
  ai_rate_limited: "The report service was busy.",
  ai_unavailable: "The report service was unavailable.",
  ai_invalid_output: "The report could not be generated.",
  enqueue_failed: "The report could not be started.",
  internal_error: "Something went wrong while generating the report.",
  openai_key_unavailable: "No working OpenAI key was available to generate the report.",
  openai_key_invalid: "Your OpenAI key was rejected while generating the report.",
  openai_quota_exhausted: "Your OpenAI account ran out of quota while generating the report.",
};

const TOC_ITEMS = [...REPORT_SECTIONS, { id: "transcript", label: "Full interview transcript" }];

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

function ReportBody({
  interviewId,
  result,
  retryError,
}: {
  interviewId: string;
  result: ApiResult<InterviewReportResponse>;
  retryError: string | null;
}) {
  if (!result.ok) {
    return (
      <Notice tone="error" className="mt-0">
        <span className="min-w-0 flex-1">Could not load the report.</span>
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
    const keyCode = isOpenAIKeySetupCode(retryError)
      ? retryError
      : isOpenAIKeySetupCode(state.error_code)
        ? state.error_code
        : null;
    return (
      <>
        <Notice tone="error" className="mt-0">
          <span className="min-w-0 flex-1">
            {retryError !== null ? "The retry could not be started. " : ""}
            {FAILURE_MESSAGES[state.error_code]}
          </span>
          {state.error_code !== "transcript_unavailable" ? <RetryForm interviewId={interviewId} /> : null}
        </Notice>
        {keyCode ? (
          <OpenAIKeyNotice
            code={keyCode}
            returnTo={`/interviews/${interviewId}/report`}
            detail="Your transcript is saved. Fix the key, then come back and retry the report."
          />
        ) : null}
      </>
    );
  }
  return <ReportView report={state.report} />;
}

export default async function InterviewReportPage({ params, searchParams }: PageProps<"/interviews/[id]/report">) {
  const { id } = await params;
  const query = await searchParams;
  const user = await requireUser(`/interviews/${encodeURIComponent(id)}/report`);
  const interview = await getInterview(id);
  if (!interview) {
    notFound();
  }
  const completed = interview.status === "completed";
  const [transcript, report, keyCode] = await Promise.all([
    getInterviewTranscript(interview.id),
    completed ? getInterviewReport(interview.id) : Promise.resolve(null),
    currentKeySetupCode(),
  ]);
  const ready = report?.ok && report.data.status === "ready" ? report.data : null;

  const transcriptSection = (
    <section
      id="transcript"
      className="mt-10 scroll-mt-[calc(var(--app-header-h)+1.5rem)] border-t pt-8 print:break-before-page"
      aria-labelledby="report-transcript"
    >
      <h2 id="report-transcript" className="font-display text-lg font-semibold">
        Full interview transcript
      </h2>
      <TranscriptDisclosure defaultOpen={!ready} count={transcript.length}>
        <InterviewTranscript entries={transcript} />
      </TranscriptDisclosure>
    </section>
  );

  return (
    <AppShell user={user} keyAlert={keyCode !== null}>
      <PageHeader
        back={{
          href: `/workspaces/${interview.workspace_id}`,
          label: <span className="font-mono">{interview.repository_full_name}</span>,
        }}
        title={`Interview ${interview.interview_number} report`}
        badge={<InterviewStatusBadge status={interview.status} terminationReason={interview.termination_reason} />}
        description={ready ? `Generated ${dateTimeFormat.format(new Date(ready.generated_at))} UTC` : undefined}
        actions={
          ready ? (
            <>
              <PrintButton label="Print report" />
              <Button asChild size="sm" className="print:hidden">
                <Link href={`/workspaces/${interview.workspace_id}`}>
                  Start next interview
                  <ArrowRight aria-hidden />
                </Link>
              </Button>
            </>
          ) : null
        }
      />

      {!completed ? (
        <Notice tone="info" className="mt-0">
          <span className="min-w-0 flex-1">
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
      ) : ready ? null : report ? (
        <ReportBody
          interviewId={interview.id}
          result={report}
          retryError={typeof query.retry_error === "string" ? query.retry_error : null}
        />
      ) : null}

      {ready ? (
        <div className="lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-12">
          <aside className="mb-8 lg:mb-0">
            <div className="lg:sticky lg:top-[calc(var(--app-header-h)+2rem)]">
              <ReportToc items={TOC_ITEMS} />
            </div>
          </aside>
          <div className="min-w-0">
            <TrackReportViewed />
            <ReportView report={ready.report} />
            {transcriptSection}
          </div>
        </div>
      ) : (
        transcriptSection
      )}
    </AppShell>
  );
}
