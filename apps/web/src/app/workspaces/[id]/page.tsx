import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ExternalLink, GitBranch, Lock } from "lucide-react";
import { type ApiErrorCode, apiErrorCodeSchema } from "@stackprep/shared";
import { AnalysisProgress } from "@/components/app/analysis-progress";
import { AppShell } from "@/components/app/app-shell";
import { deleteInterviewErrorMessage, InterviewHistoryRow } from "@/components/app/interview-history-row";
import { Notice } from "@/components/app/notice";
import { SubmitButton } from "@/components/app/submit-button";
import { WorkspaceStatusBadge } from "@/components/app/workspace-status";
import { Button } from "@/components/ui/button";
import { getInterviewHistory, getWorkspace } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { retryAnalysis, startInterview } from "./actions";

export const metadata: Metadata = {
  title: "Workspace · StackPrep",
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
        <h1 className="font-display text-2xl font-semibold tracking-tight">Workspace</h1>
        <Notice tone="error">
          <span>Could not load this workspace.</span>
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
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="truncate font-mono text-xl font-semibold tracking-tight">{repository.full_name}</h1>
        <WorkspaceStatusBadge status={workspace.status} />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
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
          className="inline-flex items-center gap-1 hover:text-foreground"
        >
          <ExternalLink className="size-3.5" aria-hidden />
          View on GitHub
        </a>
      </div>

      {retryError ? <Notice tone="error">{retryError}</Notice> : null}
      <AnalysisProgress
        workspaceId={workspace.id}
        status={workspace.status}
        analysis={workspace.analysis}
        retryAction={retryAnalysis}
      />

      {interviewError ? <Notice tone="error">{interviewError}</Notice> : null}
      <form action={startInterview} className="mt-8">
        <input type="hidden" name="workspace_id" value={workspace.id} />
        <SubmitButton disabled={!ready} pendingLabel="Starting…">
          Start Interview
        </SubmitButton>
      </form>

      <section className="mt-10" aria-labelledby="interview-history">
        <h2 id="interview-history" className="font-display text-lg font-semibold">
          Interview history
        </h2>
        {deleteError ? <Notice tone="error">{deleteError}</Notice> : null}
        {interviews.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">No interviews yet.</p>
        ) : (
          <ul className="mt-4 divide-y rounded-lg border bg-panel/60" data-testid="interview-history">
            {interviews.map((interview) => (
              <InterviewHistoryRow key={interview.id} interview={interview} returnTo={`/workspaces/${workspace.id}`} />
            ))}
          </ul>
        )}
      </section>
    </AppShell>
  );
}
