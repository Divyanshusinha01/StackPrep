"use client";

import Link from "next/link";
import { Loader2, Pause } from "lucide-react";
import { NO_REPORT_MESSAGE } from "@/components/app/end-interview";
import { type EndControl, useEndInterviewConfirm } from "@/components/app/end-interview-control";
import { Notice } from "@/components/app/notice";
import { Button } from "@/components/ui/button";

const timeFormat = new Intl.DateTimeFormat("en", { timeStyle: "short" });

export function formatResumeBy(resumeBy: string): string {
  return timeFormat.format(new Date(resumeBy));
}

/** Shown after the candidate pauses: when to come back, and the way back in or out. */
export function InterviewPaused({
  resumeBy,
  pausesLeft,
  busy,
  error,
  ended,
  endedWithoutReport,
  endControl,
  workspaceId,
  onResume,
}: {
  resumeBy: string;
  pausesLeft: number;
  busy: boolean;
  error: string | null;
  /** The interview can no longer be resumed. */
  ended: boolean;
  /** The candidate ended it before any answer was evaluated. */
  endedWithoutReport: boolean;
  /** Candidate ends the interview with a report; null once it has ended. */
  endControl: EndControl | null;
  workspaceId: string;
  onResume: () => void;
}) {
  const ending = useEndInterviewConfirm(endControl, busy);
  return (
    <section aria-labelledby="interview-paused" className="mx-auto max-w-2xl rounded-xl border bg-panel/60 p-6 sm:p-8">
      <span aria-hidden className="grid size-11 place-items-center rounded-full bg-amber-500/15 text-amber-300">
        <Pause className="size-5" />
      </span>
      <h2 id="interview-paused" className="mt-4 font-display text-lg font-semibold">
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
      {endedWithoutReport ? <Notice tone="info">{NO_REPORT_MESSAGE}</Notice> : null}
      {ending.panel}
      <div className="mt-6 flex flex-wrap gap-3">
        {ended ? null : (
          <Button onClick={onResume} disabled={busy || ending.confirming}>
            {busy && !endControl?.busy ? <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden /> : null}
            Resume interview
          </Button>
        )}
        {ending.button}
        <Button asChild variant="outline">
          <Link href={`/workspaces/${workspaceId}`}>Back to workspace</Link>
        </Button>
      </div>
    </section>
  );
}
