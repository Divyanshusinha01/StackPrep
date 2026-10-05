"use client";

import { Check, Circle, Loader2 } from "lucide-react";
import type { AnalysisErrorCode, AnalysisStage, WorkspaceAnalysis, WorkspaceStatus } from "@stackprep/shared";
import { Notice } from "@/components/app/notice";
import { SubmitButton } from "@/components/app/submit-button";
import { usePollWhile } from "@/components/app/use-poll-while";
import { cn } from "@/lib/utils";

const STAGES: { stage: AnalysisStage; label: string }[] = [
  { stage: "scanning", label: "Scanning files" },
  { stage: "analyzing", label: "Understanding architecture" },
  { stage: "preparing_context", label: "Preparing interview context" },
];

const FAILURE_MESSAGES: Record<AnalysisErrorCode, string> = {
  installation_unavailable: "The GitHub App installation is suspended or no longer has access to this repository.",
  repository_unavailable: "The repository or the selected commit is no longer accessible.",
  github_rate_limited: "GitHub rate-limited the analysis.",
  github_unavailable: "GitHub was unavailable during the analysis.",
  github_unexpected_response: "GitHub returned an unexpected response.",
  enqueue_failed: "The analysis could not be started.",
  internal_error: "Something went wrong while analyzing the repository.",
};

export function AnalysisProgress({
  workspaceId,
  status,
  analysis,
  retryAction,
}: {
  workspaceId: string;
  status: WorkspaceStatus;
  analysis: WorkspaceAnalysis | null;
  retryAction: (formData: FormData) => Promise<void>;
}) {
  usePollWhile(status === "analyzing");

  if (status === "ready") {
    return null;
  }

  if (status === "failed") {
    const code = analysis?.error_code ?? "internal_error";
    return (
      <Notice tone="error">
        <span>Repository analysis failed. {FAILURE_MESSAGES[code]}</span>
        {analysis === null || analysis.retryable ? (
          <form action={retryAction}>
            <input type="hidden" name="workspace_id" value={workspaceId} />
            <SubmitButton variant="outline" size="sm" pendingLabel="Retrying…">
              Retry analysis
            </SubmitButton>
          </form>
        ) : null}
      </Notice>
    );
  }

  const queued = analysis === null || analysis.state === "queued";
  const currentIndex = analysis?.stage ? STAGES.findIndex((s) => s.stage === analysis.stage) : -1;

  return (
    <section
      aria-labelledby="analysis-progress"
      aria-live="polite"
      className="mt-6 rounded-md border border-border bg-panel/60 px-4 py-4"
    >
      <h2 id="analysis-progress" className="text-sm font-medium">
        {queued ? "Analysis queued" : "Analyzing repository"}
      </h2>
      <ol className="mt-3 space-y-2 text-sm">
        {STAGES.map(({ stage, label }, index) => {
          const done = currentIndex > index;
          const current = currentIndex === index;
          return (
            <li
              key={stage}
              aria-current={current ? "step" : undefined}
              className={cn("flex items-center gap-2", done || current ? "text-foreground" : "text-muted-foreground")}
            >
              {done ? (
                <Check className="size-4 text-emerald-300" aria-hidden />
              ) : current ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <Circle className="size-4" aria-hidden />
              )}
              {label}
              <span className="sr-only">{done ? "(done)" : current ? "(in progress)" : "(pending)"}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
