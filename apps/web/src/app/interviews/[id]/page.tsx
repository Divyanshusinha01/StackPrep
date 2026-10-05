import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { AppShell } from "@/components/app/app-shell";
import { InterviewLobby } from "@/components/app/interview-lobby";
import { InterviewStatusBadge } from "@/components/app/interview-status";
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
        <h1 className="font-display text-2xl font-semibold tracking-tight">Interview {interview.interview_number}</h1>
        <InterviewStatusBadge status={interview.status} />
      </div>
      <p className="mt-2 text-sm text-muted-foreground">
        The interview uses your camera and microphone. Both are required to continue.
      </p>
      <InterviewLobby planning={interview.planning} />
    </AppShell>
  );
}
