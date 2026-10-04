import type { Metadata } from "next";
import Link from "next/link";
import { GitBranch, Lock } from "lucide-react";
import { AppShell } from "@/components/app/app-shell";
import { Notice } from "@/components/app/notice";
import { WorkspaceStatusBadge } from "@/components/app/workspace-status";
import { Button } from "@/components/ui/button";
import { listWorkspaces } from "@/lib/api";
import { requireUser } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Workspaces · StackPrep",
  robots: { index: false },
};

export default async function WorkspacesPage() {
  const user = await requireUser("/workspaces");
  const result = await listWorkspaces();

  return (
    <AppShell user={user}>
      <div className="flex items-center justify-between gap-4">
        <h1 className="font-display text-2xl font-semibold tracking-tight">Workspaces</h1>
        <Button asChild>
          <Link href="/workspaces/new">New workspace</Link>
        </Button>
      </div>

      {!result.ok ? (
        <Notice tone="error">
          <span>Could not load your workspaces.</span>
          <Button asChild variant="outline" size="sm">
            <Link href="/workspaces">Reload</Link>
          </Button>
        </Notice>
      ) : result.data.workspaces.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">
          Connect GitHub and choose a repository to start a workspace.
        </p>
      ) : (
        <ul className="mt-6 divide-y rounded-lg border bg-panel/60" data-testid="workspace-list">
          {result.data.workspaces.map((workspace) => (
            <li key={workspace.id} className="flex items-center gap-3 px-4 py-3 text-sm">
              <Link
                href={`/workspaces/${workspace.id}`}
                className="truncate font-mono text-[13px] hover:underline"
              >
                {workspace.repository.full_name}
              </Link>
              {workspace.repository.is_private ? (
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                  <Lock className="size-3" aria-hidden />
                  Private
                </span>
              ) : null}
              <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                <GitBranch className="size-3" aria-hidden />
                {workspace.repository.default_branch}
              </span>
              <WorkspaceStatusBadge status={workspace.status} />
            </li>
          ))}
        </ul>
      )}
    </AppShell>
  );
}
