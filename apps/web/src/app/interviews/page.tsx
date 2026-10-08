import type { Metadata } from "next";
import Link from "next/link";
import { AppShell } from "@/components/app/app-shell";
import { deleteInterviewErrorMessage, InterviewHistoryRow } from "@/components/app/interview-history-row";
import { Notice } from "@/components/app/notice";
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
      <h1 className="font-display text-2xl font-semibold tracking-tight">Interviews</h1>
      {deleteError ? <Notice tone="error">{deleteError}</Notice> : null}
      {groups.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">
          No interviews yet. Start one from a{" "}
          <Link href="/workspaces" className="underline hover:text-foreground">
            repository workspace
          </Link>
          .
        </p>
      ) : (
        groups.map((group) => (
          <section key={group.workspace_id} className="mt-8" aria-labelledby={`workspace-${group.workspace_id}`}>
            <h2 id={`workspace-${group.workspace_id}`} className="font-mono text-sm font-semibold">
              <Link href={`/workspaces/${group.workspace_id}`} className="hover:underline">
                {group.repository_full_name}
              </Link>
            </h2>
            <ul className="mt-3 divide-y rounded-lg border bg-panel/60" data-testid="interview-history">
              {group.interviews.map((interview) => (
                <InterviewHistoryRow key={interview.id} interview={interview} returnTo="/interviews" />
              ))}
            </ul>
          </section>
        ))
      )}
    </AppShell>
  );
}
