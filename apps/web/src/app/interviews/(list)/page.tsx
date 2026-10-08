import type { Metadata } from "next";
import Link from "next/link";
import { FolderGit2, MessagesSquare } from "lucide-react";
import { AppShell } from "@/components/app/app-shell";
import { EmptyState } from "@/components/app/empty-state";
import { deleteInterviewErrorMessage, InterviewHistoryRow } from "@/components/app/interview-history-row";
import { Notice } from "@/components/app/notice";
import { PageHeader } from "@/components/app/page-header";
import { Button } from "@/components/ui/button";
import { getInterviewHistory } from "@/lib/api";
import { requireUser } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Interviews · StackPrep",
  robots: { index: false },
};

export default async function InterviewsPage({ searchParams }: PageProps<"/interviews">) {
  const query = await searchParams;
  const deleteError = deleteInterviewErrorMessage(query.delete_error);
  const user = await requireUser("/interviews");
  const groups = await getInterviewHistory();

  return (
    <AppShell user={user}>
      <PageHeader title="Interviews" description="Every interview across your repositories, newest first." />
      {deleteError ? <Notice tone="error">{deleteError}</Notice> : null}
      {groups.length === 0 ? (
        <EmptyState
          icon={<MessagesSquare />}
          title="No interviews yet"
          description="Start one from a repository workspace once its analysis has finished."
          action={
            <Button asChild>
              <Link href="/workspaces">Go to workspaces</Link>
            </Button>
          }
        />
      ) : (
        <div className="space-y-8">
          {groups.map((group) => (
            <section key={group.workspace_id} aria-labelledby={`workspace-${group.workspace_id}`}>
              <h2 id={`workspace-${group.workspace_id}`} className="flex items-center gap-2 text-sm font-semibold">
                <FolderGit2 className="size-4 text-brand" aria-hidden />
                <Link
                  href={`/workspaces/${group.workspace_id}`}
                  className="focus-ring truncate rounded-sm font-mono hover:underline"
                >
                  {group.repository_full_name}
                </Link>
              </h2>
              <ul className="mt-3 divide-y overflow-hidden rounded-xl border bg-panel/60" data-testid="interview-history">
                {group.interviews.map((interview) => (
                  <InterviewHistoryRow key={interview.id} interview={interview} returnTo="/interviews" />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </AppShell>
  );
}
