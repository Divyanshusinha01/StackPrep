import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Clock, ExternalLink, GitBranch, History, Lock, Mic } from "lucide-react";
import { type ApiErrorCode, apiErrorCodeSchema } from "@stackprep/shared";
import { AnalysisProgress } from "@/components/app/analysis-progress";
import { AppShell } from "@/components/app/app-shell";
import { EmptyState } from "@/components/app/empty-state";
import { deleteInterviewErrorMessage, InterviewHistoryRow } from "@/components/app/interview-history-row";
import { Notice } from "@/components/app/notice";
import { PageHeader } from "@/components/app/page-header";
import { SubmitButton } from "@/components/app/submit-button";
import { WorkspaceStatusBadge } from "@/components/app/workspace-status";
import { CTA_GLOW } from "@/components/landing/constants";
import { Button } from "@/components/ui/button";
import { getInterviewHistory, getWorkspace } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { retryAnalysis, startInterview } from "./actions";

export const metadata: Metadata = {
  title: "Workspace",
  robots: { index: false },
};

const RETRY_ERROR_MESSAGES: Partial<Record<ApiErrorCode, string>> = {
  analysis_not_retryable: "This analysis is already running or has finished.",
  connection_not_found: "Reconnect GitHub to retry the analysis.",
  installation_suspended: "The GitHub App installation is suspended. Re-enable it on GitHub to retry.",
};

const INTERVIEW_ERROR_MESSAGES: Partial<Record<ApiErrorCode, string>> = {
  workspace_not_ready: "The repository analysis has to finish before you can start an interview.",
  interview_limit_reached: "You have started 5 interviews in the last 24 hours.",
};

const dateTimeFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

function errorCode(value: string | string[] | undefined): ApiErrorCode | "unknown" | null {
  if (typeof value !== "string") {
    return null;
  }
  const parsed = apiErrorCodeSchema.safeParse(value);
  return parsed.success ? parsed.data : "unknown";
}

function retryErrorMessage(value: string | string[] | undefined): string | null {
  const code = errorCode(value);
  if (code === null) {
    return null;
  }
  return (code !== "unknown" && RETRY_ERROR_MESSAGES[code]) || "Could not retry the analysis. Try again.";
}

function interviewErrorMessage(
  value: string | string[] | undefined,
  nextAvailableAt: string | string[] | undefined,
): string | null {
  const code = errorCode(value);
  if (code === null) {
    return null;
  }
  const message = (code !== "unknown" && INTERVIEW_ERROR_MESSAGES[code]) || "Could not start the interview. Try again.";
  const next = typeof nextAvailableAt === "string" ? new Date(nextAvailableAt) : null;
  if (code === "interview_limit_reached" && next && !Number.isNaN(next.getTime())) {
    return `${message} You can start another after ${dateTimeFormat.format(next)} UTC.`;
  }
  return message;
}

export default async function WorkspacePage({ params, searchParams }: PageProps<"/workspaces/[id]">) {
  const { id } = await params;
  const query = await searchParams;
  const retryError = retryErrorMessage(query.retry_error);
  const interviewError = interviewErrorMessage(query.interview_error, query.next_available_at);
  const deleteError = deleteInterviewErrorMessage(query.delete_error);
  const user = await requireUser(`/workspaces/${encodeURIComponent(id)}`);
  const result = await getWorkspace(id);

  if (!result.ok) {
    if (result.code === "workspace_not_found") {
      notFound();
    }
    return (
      <AppShell user={user}>
        <PageHeader back={{ href: "/workspaces", label: "Workspaces" }} title="Workspace" />
        <Notice tone="error">
          <span className="min-w-0 flex-1">Could not load this workspace.</span>
          <Button asChild variant="outline" size="sm">
            <Link href={`/workspaces/${encodeURIComponent(id)}`}>Reload</Link>
          </Button>
        </Notice>
      </AppShell>
    );
  }

  const { workspace, repository } = result.data;
  const ready = workspace.status === "ready";
  const interviews = (await getInterviewHistory(workspace.id))[0]?.interviews ?? [];

  return (
    <AppShell user={user}>
      <PageHeader
        back={{ href: "/workspaces", label: "Workspaces" }}
        title={repository.full_name}
        titleClassName="font-mono text-xl sm:text-2xl"
        badge={<WorkspaceStatusBadge status={workspace.status} />}
      >
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm text-muted-foreground">
          {repository.is_private ? (
            <span className="inline-flex items-center gap-1">
              <Lock className="size-3.5" aria-hidden />
              Private
            </span>
          ) : null}
          <span className="inline-flex items-center gap-1">
            <GitBranch className="size-3.5" aria-hidden />
            {repository.default_branch}
          </span>
          <a
            href={repository.html_url}
            target="_blank"
            rel="noreferrer"
            className="focus-ring inline-flex items-center gap-1 rounded-sm hover:text-foreground"
          >
            <ExternalLink className="size-3.5" aria-hidden />
            View on GitHub
          </a>
        </div>
      </PageHeader>

      <section
        aria-labelledby="start-interview"
        className={cn(
          "surface-inset relative overflow-hidden rounded-xl border p-6",
          ready
            ? "border-brand/30 bg-linear-to-br from-panel-raised/90 via-panel/80 to-panel/60"
            : workspace.status === "failed"
              ? "border-red-500/25 bg-panel/70"
              : "border-border-strong/60 bg-panel/60",
        )}
      >
        {ready ? (
          <div aria-hidden className="glow-brand pointer-events-none absolute -top-24 -right-24 size-72 opacity-40" />
        ) : null}
        <div className="relative flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h2 id="start-interview" className="flex items-center gap-2.5 font-display text-lg font-semibold tracking-tight">
              <span
                aria-hidden
                className={cn(
                  "grid size-8 shrink-0 place-items-center rounded-lg border",
                  ready ? "border-brand/30 bg-brand-muted text-brand" : "border-border bg-panel-raised text-muted-foreground",
                )}
              >
                <Mic className="size-4" />
              </span>
              {interviews.length === 0 ? "Start your first interview" : "Start a new interview"}
            </h2>
            <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">
              {ready
                ? "The interviewer has read this repository and will ask about its architecture and your decisions. Plan for about 30 minutes; camera and microphone are required."
                : workspace.status === "failed"
                  ? "Interviews are available once the repository analysis succeeds. Retry it below."
                  : "Interviews are available as soon as the repository analysis below finishes."}
            </p>
            <p className="mt-3 inline-flex items-center gap-1.5 font-mono text-xs text-muted-foreground/90">
              <Clock className="size-3.5 text-brand/80" aria-hidden />
              You can start up to 5 interviews in any 24 hours, across all workspaces.
            </p>
          </div>
          <form action={startInterview} className="shrink-0">
            <input type="hidden" name="workspace_id" value={workspace.id} />
            <SubmitButton
              disabled={!ready}
              pendingLabel="Starting…"
              size="lg"
              className={cn("w-full sm:w-auto", ready && CTA_GLOW)}
            >
              Start Interview
            </SubmitButton>
          </form>
        </div>
        {interviewError ? <Notice tone="error">{interviewError}</Notice> : null}
        {retryError ? <Notice tone="error">{retryError}</Notice> : null}
        <AnalysisProgress
          workspaceId={workspace.id}
          status={workspace.status}
          analysis={workspace.analysis}
          retryAction={retryAnalysis}
        />
      </section>

      <section className="mt-10" aria-labelledby="interview-history">
        <div className="flex items-baseline justify-between gap-3">
          <h2 id="interview-history" className="font-display text-lg font-semibold tracking-tight">
            Interview history
          </h2>
          {interviews.length > 0 ? (
            <span className="font-mono text-xs text-muted-foreground tabular-nums">
              {interviews.length} {interviews.length === 1 ? "interview" : "interviews"}
            </span>
          ) : null}
        </div>
        {deleteError ? <Notice tone="error">{deleteError}</Notice> : null}
        {interviews.length === 0 ? (
          <EmptyState
            className="mt-4 py-10"
            headingLevel={3}
            icon={<History />}
            title="No interviews yet."
            description="Each interview and its report will be listed here."
          />
        ) : (
          <ul
            className="surface-inset mt-4 divide-y overflow-hidden rounded-xl border bg-panel/60"
            data-testid="interview-history"
          >
            {interviews.map((interview) => (
              <InterviewHistoryRow key={interview.id} interview={interview} returnTo={`/workspaces/${workspace.id}`} />
            ))}
          </ul>
        )}
      </section>
    </AppShell>
  );
}
