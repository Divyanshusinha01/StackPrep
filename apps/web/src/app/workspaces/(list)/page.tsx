import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronRight, FolderGit2, Plus } from "lucide-react";
import { AppShell } from "@/components/app/app-shell";
import { EmptyState } from "@/components/app/empty-state";
import { InterviewStatusBadge } from "@/components/app/interview-status";
import { Notice } from "@/components/app/notice";
import { PageHeader } from "@/components/app/page-header";
import { RepoMeta, RepoName } from "@/components/app/repo-meta";
import { SetupChecklist } from "@/components/app/setup-checklist";
import { SurfaceList } from "@/components/app/surface";
import { WorkspaceStatusBadge } from "@/components/app/workspace-status";
import { Button } from "@/components/ui/button";
import { getInterviewHistory, type InterviewHistoryEntry, listWorkspaces } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { currentKeySetupCode } from "@/lib/openai-key-gate";
import { onboardingSetupHref } from "@/lib/return-to";

export const metadata: Metadata = {
  title: "Workspaces",
  robots: { index: false },
};

const dateFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" });

/** Latest interview per workspace; best effort, so the list still renders without it. */
async function latestInterviews(): Promise<Map<string, InterviewHistoryEntry>> {
  try {
    const groups = await getInterviewHistory();
    return new Map(groups.flatMap((g) => (g.interviews[0] ? [[g.workspace_id, g.interviews[0]] as const] : [])));
  } catch {
    return new Map();
  }
}

export default async function WorkspacesPage() {
  const user = await requireUser("/workspaces");
  const [result, latest, keyCode] = await Promise.all([listWorkspaces(), latestInterviews(), currentKeySetupCode()]);
  const empty = result.ok && result.data.workspaces.length === 0;
  // First run only: the key comes before any repository. Existing workspaces stay browsable without one.
  if (empty && keyCode) {
    redirect(onboardingSetupHref("/workspaces/new"));
  }

  return (
    <AppShell user={user} keyAlert={keyCode !== null}>
      <PageHeader
        title="Workspaces"
        description="One workspace per repository. Open one to start an interview or review past reports."
        actions={
          empty ? null : (
            <Button asChild>
              <Link href="/workspaces/new">
                <Plus aria-hidden />
                New workspace
              </Link>
            </Button>
          )
        }
      />

      {!result.ok ? (
        <Notice tone="error">
          <span className="min-w-0 flex-1">Could not load your workspaces.</span>
          <Button asChild variant="outline" size="sm">
            <Link href="/workspaces">Reload</Link>
          </Button>
        </Notice>
      ) : empty ? (
        <>
          <SetupChecklist keyReady className="mb-6" />
          <EmptyState
            icon={<FolderGit2 />}
            title="No workspaces yet"
            description="Connect GitHub and choose a repository to start a workspace."
            action={
              <Button asChild>
                <Link href="/workspaces/new">
                  <Plus aria-hidden />
                  New workspace
                </Link>
              </Button>
            }
          />
        </>
      ) : (
        <SurfaceList data-testid="workspace-list">
          {result.data.workspaces.map((workspace) => {
            const last = latest.get(workspace.id);
            return (
              <li
                key={workspace.id}
                className="group relative flex min-w-0 items-center gap-4 px-4 py-4 transition-colors focus-within:bg-panel-raised/70 hover:bg-panel-raised/60 sm:px-5"
              >
                <div
                  aria-hidden
                  className="hidden size-10 shrink-0 place-items-center rounded-lg border border-brand/25 bg-brand-muted/70 text-brand sm:grid"
                >
                  <FolderGit2 className="size-4.5" />
                </div>
                <div className="min-w-0 flex-1">
                  <Link
                    href={`/workspaces/${workspace.id}`}
                    className="block truncate font-mono text-sm outline-none after:absolute after:inset-0 focus-visible:after:ring-[3px] focus-visible:after:ring-ring/50 focus-visible:after:ring-inset"
                  >
                    <RepoName fullName={workspace.repository.full_name} />
                  </Link>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <RepoMeta
                      isPrivate={workspace.repository.is_private}
                      defaultBranch={workspace.repository.default_branch}
                    />
                    <span>
                      {last ? (
                        <>
                          Last interview{" "}
                          <time dateTime={last.created_at} className="tabular-nums">
                            {dateFormat.format(new Date(last.created_at))}
                          </time>
                        </>
                      ) : (
                        "No interviews yet"
                      )}
                    </span>
                  </div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1.5 sm:flex-row sm:items-center sm:gap-2.5">
                  {last ? (
                    <span className="hidden md:inline-flex">
                      <InterviewStatusBadge status={last.status} terminationReason={last.termination_reason} />
                    </span>
                  ) : null}
                  <WorkspaceStatusBadge status={workspace.status} />
                </div>
                <ChevronRight
                  aria-hidden
                  className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground"
                />
              </li>
            );
          })}
        </SurfaceList>
      )}
    </AppShell>
  );
}
