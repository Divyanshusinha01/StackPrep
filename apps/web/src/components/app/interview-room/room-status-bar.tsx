"use client";

import { Loader2, Pause } from "lucide-react";
import { MAX_INTERVIEW_PAUSES, PAUSE_RESUME_WINDOW_SECONDS } from "@stackprep/shared";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { formatClock } from "@/components/app/interview-room/use-elapsed";
import { StatusChip } from "@/components/app/status-chip";
import type { RealtimeErrorCode, RealtimeStatus } from "@/components/app/use-realtime-interview";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface StopControl {
  pausesLeft: number;
  busy: boolean;
  error: string | null;
  onStop: () => void;
}

function ConnectionStatus({
  status,
  error,
  termination,
  ended,
  timeUp,
}: {
  status: RealtimeStatus;
  error: RealtimeErrorCode | null;
  termination: boolean;
  ended: boolean;
  timeUp: boolean;
}) {
  if (status === "connecting" || (status === "error" && error === "interview_preparing")) {
    return (
      <span className="flex items-center gap-2 text-muted-foreground">
        <Loader2 className="size-4 shrink-0 motion-safe:animate-spin text-brand" aria-hidden />
        <span className="truncate">
          {status === "connecting" ? "Connecting to your interviewer…" : "Preparing your interview…"}
        </span>
      </span>
    );
  }
  if (status === "live") {
    return (
      <StatusChip tone="danger" pulse className="font-semibold tracking-wide">
        Live
      </StatusChip>
    );
  }
  if (status === "reconnecting") {
    return (
      <span className="flex items-center gap-2 text-muted-foreground">
        <Loader2 className="size-4 shrink-0 motion-safe:animate-spin text-brand" aria-hidden />
        <span className="truncate">Reconnecting… your answers are saved</span>
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="flex min-w-0 items-center gap-2">
        <StatusChip tone="warning">Disconnected</StatusChip>
        <span className="hidden truncate text-muted-foreground sm:inline">Your answers are saved</span>
      </span>
    );
  }
  if (status === "closed") {
    return (
      <span className="truncate text-muted-foreground">
        {termination ? "Interview ended" : ended ? "Interview complete" : timeUp ? "Interview time is over" : "Disconnected"}
      </span>
    );
  }
  return null;
}

/** Sticky row under the app header: connection state, elapsed time, and Stop / End. */
export function RoomStatusBar({
  status,
  error,
  termination,
  ended,
  timeUp,
  elapsed,
  wrappingUp,
  stop,
  confirmingStop,
  onConfirmingStopChange,
  stopDisabled,
  endButton,
}: {
  status: RealtimeStatus;
  error: RealtimeErrorCode | null;
  termination: boolean;
  ended: boolean;
  timeUp: boolean;
  elapsed: number;
  wrappingUp: boolean;
  stop: StopControl | null;
  confirmingStop: boolean;
  onConfirmingStopChange: (open: boolean) => void;
  stopDisabled: boolean;
  endButton: React.ReactNode;
}) {
  return (
    <div className="sticky top-[var(--app-header-h)] z-30 -mx-4 border-b border-border/80 bg-background/90 px-4 py-3 backdrop-blur-md sm:-mx-6 sm:px-6">
      <div className="flex items-center gap-3.5 text-sm">
        <span aria-live="polite" className="flex min-w-0 items-center">
          <ConnectionStatus status={status} error={error} termination={termination} ended={ended} timeUp={timeUp} />
        </span>
        <span
          className={cn(
            "inline-flex items-baseline gap-2 rounded-md border px-2.5 py-1 font-mono text-sm font-medium tabular-nums",
            wrappingUp ? "border-brand/40 bg-brand-muted/50 text-brand" : "border-border/80 bg-panel/70 text-foreground",
          )}
        >
          <span aria-hidden className="hidden font-sans text-xs font-normal text-muted-foreground sm:inline">
            Elapsed
          </span>
          <span role="timer" aria-label="Elapsed time">
            {formatClock(elapsed)}
          </span>
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {stop ? (
            stop.pausesLeft > 0 ? (
              <ConfirmDialog
                open={confirmingStop}
                onOpenChange={onConfirmingStopChange}
                tone="default"
                title="Stop the interview for now?"
                description={
                  <>
                    <p>
                      Your answers are saved and your voice time stops. Resume within{" "}
                      {PAUSE_RESUME_WINDOW_SECONDS / 60} minutes or the interview ends.
                    </p>
                    <p className="mt-2 text-xs">
                      {stop.pausesLeft} of {MAX_INTERVIEW_PAUSES} {stop.pausesLeft === 1 ? "pause" : "pauses"} left.
                    </p>
                  </>
                }
                confirmLabel="Stop interview"
                cancelLabel="Keep going"
                disabled={stop.busy}
                onConfirm={stop.onStop}
                trigger={
                  <Button variant="outline" size="sm" disabled={stopDisabled}>
                    <Pause className="size-3.5" aria-hidden />
                    <span className="max-sm:sr-only">Stop interview</span>
                  </Button>
                }
              />
            ) : (
              <span className="hidden font-mono text-xs text-muted-foreground sm:inline">No pauses left</span>
            )
          ) : null}
          {endButton}
        </div>
      </div>
    </div>
  );
}
