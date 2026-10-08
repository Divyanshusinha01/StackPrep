"use client";

import Link from "next/link";
import { Loader2, Pause } from "lucide-react";
import { Notice } from "@/components/app/notice";
import { Button } from "@/components/ui/button";

const timeFormat = new Intl.DateTimeFormat("en", { timeStyle: "short" });

export function formatResumeBy(resumeBy: string): string {
  return timeFormat.format(new Date(resumeBy));
}

/** Shown after the candidate pauses: when to come back, and the way back in. */
export function InterviewPaused({
  resumeBy,
  pausesLeft,
  busy,
  error,
  ended,
  workspaceId,
  onResume,
}: {
  resumeBy: string;
  pausesLeft: number;
  busy: boolean;
  error: string | null;
  /** The interview can no longer be resumed. */
  ended: boolean;
  workspaceId: string;
  onResume: () => void;
}) {
  return (
    <section aria-labelledby="interview-paused" className="mt-6 rounded-md border border-border bg-panel/60 p-6">
      <h2 id="interview-paused" className="flex items-center gap-2 text-base font-medium">
        <Pause className="size-4" aria-hidden />
        Interview paused
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Your answers are saved and your voice time is stopped. Resume by{" "}
        <span className="text-foreground" suppressHydrationWarning>
          {formatResumeBy(resumeBy)}
        </span>
        , or the interview ends. You can close this
        page and come back from your interview history.
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        {pausesLeft === 0 ? "This was your last pause." : `${pausesLeft} more ${pausesLeft === 1 ? "pause" : "pauses"} left.`}
      </p>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className="mt-4 flex flex-wrap gap-3">
        {ended ? null : (
          <Button onClick={onResume} disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            Resume interview
          </Button>
        )}
        <Button asChild variant="outline">
          <Link href={`/workspaces/${workspaceId}`}>Back to workspace</Link>
        </Button>
      </div>
    </section>
  );
}
