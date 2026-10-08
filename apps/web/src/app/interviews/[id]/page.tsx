import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { MAX_INTERVIEW_PAUSES } from "@stackprep/shared";
import { AppShell } from "@/components/app/app-shell";
import { InterviewSession } from "@/components/app/interview-session";
import { PageHeader } from "@/components/app/page-header";
import { getInterview } from "@/lib/api";
import { requireUser } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Interview · StackPrep",
  robots: { index: false },
};

export default async function InterviewPage({ params }: PageProps<"/interviews/[id]">) {
  const { id } = await params;
  const user = await requireUser(`/interviews/${encodeURIComponent(id)}`);
  const interview = await getInterview(id);
  if (!interview) {
    notFound();
  }
  if (interview.status === "completed" || interview.status === "terminated" || interview.status === "failed") {
    redirect(`/interviews/${encodeURIComponent(interview.id)}/report`);
  }

  return (
    <AppShell user={user}>
      <PageHeader
        back={{
          href: `/workspaces/${interview.workspace_id}`,
          label: <span className="font-mono">{interview.repository_full_name}</span>,
        }}
        title={`Interview ${interview.interview_number}`}
        description="The interview uses your camera and microphone. Both are required to continue."
      />
      <InterviewSession
        interviewId={interview.id}
        workspaceId={interview.workspace_id}
        planning={interview.planning}
        pausedAt={interview.status === "paused" ? interview.paused_at : null}
        pausesLeft={Math.max(0, MAX_INTERVIEW_PAUSES - interview.pause_count)}
      />
    </AppShell>
  );
}
