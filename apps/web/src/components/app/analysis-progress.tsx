"use client";

import { Check, Loader2 } from "lucide-react";
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
        <span className="min-w-0 flex-1">Repository analysis failed. {FAILURE_MESSAGES[code]}</span>
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
      className="mt-6 border-t border-border/80 pt-5"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 id="analysis-progress" className="font-mono text-xs font-medium tracking-wider text-muted-foreground uppercase">
          {queued ? "Analysis queued" : "Analyzing repository"}
        </h2>
        <span className="font-mono text-xs text-brand tabular-nums">
          {currentIndex >= 0 ? `Step ${currentIndex + 1} of ${STAGES.length}` : "Queued"}
        </span>
      </div>
      <ol className="mt-3.5 grid gap-3 text-sm sm:grid-cols-3 sm:gap-4">
        {STAGES.map(({ stage, label }, index) => {
          const done = currentIndex > index;
          const current = currentIndex === index;
          return (
            <li
              key={stage}
              aria-current={current ? "step" : undefined}
              className={cn(
                "relative flex items-center gap-3 rounded-lg border px-3.5 py-2.5 transition-colors",
                done && "border-success/30 bg-success/[0.06] text-foreground",
                current && "border-brand/40 bg-brand-muted/50 text-foreground",
                !done && !current && "border-border/70 bg-background/40 text-muted-foreground",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "grid size-6 shrink-0 place-items-center rounded-full border font-mono text-[11px] font-semibold tabular-nums transition-colors",
                  done && "border-success/40 bg-success/15 text-success",
                  current && "border-brand/50 bg-brand-muted text-brand",
                  !done && !current && "border-border text-muted-foreground",
                )}
              >
                {done ? (
                  <Check className="size-3.5" />
                ) : current ? (
                  <Loader2 className="size-3.5 motion-safe:animate-spin" />
                ) : (
                  index + 1
                )}
              </span>
              <span className="font-medium">
                {label}
                <span className="sr-only">{done ? " (done)" : current ? " (in progress)" : " (pending)"}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
