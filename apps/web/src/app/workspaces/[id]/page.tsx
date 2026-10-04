import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ExternalLink, GitBranch, Lock } from "lucide-react";
import { type ApiErrorCode, apiErrorCodeSchema } from "@stackprep/shared";
import { AnalysisProgress } from "@/components/app/analysis-progress";
import { AppShell } from "@/components/app/app-shell";
import { Notice } from "@/components/app/notice";
import { WorkspaceStatusBadge } from "@/components/app/workspace-status";
import { Button } from "@/components/ui/button";
import { getWorkspace } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { retryAnalysis } from "./actions";

export const metadata: Metadata = {
  title: "Workspace · StackPrep",
  robots: { index: false },
};

const RETRY_ERROR_MESSAGES: Partial<Record<ApiErrorCode, string>> = {
  analysis_not_retryable: "This analysis is already running or has finished.",
  connection_not_found: "Reconnect GitHub to retry the analysis.",
  installation_suspended: "The GitHub App installation is suspended. Re-enable it on GitHub to retry.",
};

function retryErrorMessage(value: string | string[] | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const parsed = apiErrorCodeSchema.safeParse(value);
  return (parsed.success && RETRY_ERROR_MESSAGES[parsed.data]) || "Could not retry the analysis. Try again.";
}

export default async function WorkspacePage({ params, searchParams }: PageProps<"/workspaces/[id]">) {
  const { id } = await params;
  const retryError = retryErrorMessage((await searchParams).retry_error);
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

  const { workspace, repository, interviews } = result.data;

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

      <div className="mt-8">
        <Button disabled aria-disabled>
          Start Interview
        </Button>
      </div>

      <section className="mt-10" aria-labelledby="interview-history">
        <h2 id="interview-history" className="font-display text-lg font-semibold">
          Interview history
        </h2>
        {interviews.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">No interviews yet.</p>
        ) : null}
      </section>
    </AppShell>
  );
}
