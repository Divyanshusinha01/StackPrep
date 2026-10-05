"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Bot, FileSearch, Loader2, Mic } from "lucide-react";
import { INTEGRITY_WARNING_LIMIT, type PauseReason, VOICE_WRAP_UP_SECONDS } from "@stackprep/shared";
import { type ExaminedItem, examiningLabel } from "@/components/app/examining";
import { Notice } from "@/components/app/notice";
import type { TranscriptTurn } from "@/components/app/realtime-transcript";
import type { IntegrityWarning } from "@/components/app/use-integrity-monitor";
import {
  NOT_RETRYABLE,
  type RealtimeErrorCode,
  type RealtimeStatus,
  type VoiceClock,
} from "@/components/app/use-realtime-interview";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const ROOM_ERRORS: Partial<Record<RealtimeErrorCode, string>> = {
  microphone_denied: "Camera or microphone access was blocked. Allow access in your browser settings and reconnect.",
  microphone_unavailable: "No working camera or microphone was found. Connect them and reconnect.",
  connection_failed: "Could not connect to the voice interviewer. Check your connection and try again.",
  connection_lost:
    "We could not reconnect automatically. Your voice time is paused and your answers are saved; reconnect to continue.",
  realtime_unavailable: "The voice interviewer is unavailable right now. Try again in a moment.",
  interview_preparing: "The interview is still being prepared. Retrying shortly…",
  interview_planning_failed: "This interview could not be prepared. Start a new interview from the workspace.",
  interview_not_active: "This interview has ended.",
  interview_not_found: "This interview could not be found.",
  unauthorized: "Your session expired. Sign in again to continue.",
};

const PAUSE_REASONS: Record<PauseReason, string> = {
  camera: "Your camera stopped",
  microphone: "Your microphone stopped",
  network: "Your network connection dropped",
  connection: "The connection to the interviewer dropped",
};

/** How long "Resumed" stays on screen after a reconnect. */
const RESUMED_NOTICE_MS = 6000;

/** True for a few seconds after `resumed` turns on. */
function useBriefly(on: boolean, ms: number): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!on) {
      return;
    }
    const show = window.setTimeout(() => setVisible(true), 0);
    const hide = window.setTimeout(() => setVisible(false), ms);
    return () => {
      window.clearTimeout(show);
      window.clearTimeout(hide);
      setVisible(false);
    };
  }, [on, ms]);
  return on && visible;
}

function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** Elapsed voice time; ticks only while connected, matching how the backend counts it. */
function useElapsed(clock: VoiceClock | null, live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) {
      return;
    }
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [live]);
  if (!clock) {
    return 0;
  }
  return clock.usedSeconds + Math.max(0, (now - clock.connectedAt) / 1000);
}

function TranscriptPane({
  title,
  icon,
  turns,
  placeholder,
}: {
  title: string;
  icon: React.ReactNode;
  turns: TranscriptTurn[];
  placeholder: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const id = `pane-${title.toLowerCase()}`;

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [turns]);

  return (
    <section aria-labelledby={id} className="flex min-h-0 flex-col rounded-md border border-border bg-panel/60">
      <h2 id={id} className="flex items-center gap-2 border-b border-border px-4 py-2.5 text-sm font-medium">
        {icon}
        {title}
      </h2>
      <div
        ref={scrollRef}
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
        onScroll={(e) => {
          const el = e.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
        className="h-72 space-y-3 overflow-y-auto px-4 py-3 text-sm leading-relaxed md:h-[26rem]"
      >
        {turns.length === 0 ? <p className="text-muted-foreground">{placeholder}</p> : null}
        {turns.map((turn) => (
          <p key={turn.itemId} className={cn(turn.final ? "text-foreground" : "text-foreground/70")}>
            {turn.text || <span className="text-muted-foreground">…</span>}
            {turn.interrupted ? <span className="ml-1 text-xs text-muted-foreground">(cut off)</span> : null}
          </p>
        ))}
      </div>
    </section>
  );
}

/** Which file or module the interviewer is looking at; paths only, never content or reasoning. */
function ExaminingIndicator({ items }: { items: ExaminedItem[] | null }) {
  const label = items ? examiningLabel(items) : "";
  return (
    <p
      aria-live="polite"
      title={items?.map((item) => item.path).join("\n")}
      className="mt-2 flex h-5 items-center gap-2 text-xs text-muted-foreground"
    >
      {label ? (
        <>
          <FileSearch className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate font-mono">{label}</span>
        </>
      ) : null}
    </p>
  );
}

export function InterviewRoom({
  status,
  error,
  timeUp,
  ended,
  pauseReason,
  resumed,
  warning,
  termination,
  workspaceId,
  examining,
  clock,
  transcript,
  onReconnect,
  onDismissWarning,
}: {
  status: RealtimeStatus;
  error: RealtimeErrorCode | null;
  timeUp: boolean;
  ended: boolean;
  pauseReason: PauseReason | null;
  resumed: boolean;
  warning: IntegrityWarning | null;
  /** Set once the interview was terminated for integrity; the message to show. */
  termination: string | null;
  workspaceId: string;
  examining: ExaminedItem[] | null;
  clock: VoiceClock | null;
  transcript: { ai: TranscriptTurn[]; user: TranscriptTurn[] };
  onReconnect: () => void;
  onDismissWarning: () => void;
}) {
  const live = status === "live";
  const elapsed = useElapsed(clock, live);
  const wrappingUp = live && elapsed >= VOICE_WRAP_UP_SECONDS;
  const showResumed = useBriefly(resumed && live, RESUMED_NOTICE_MS);
  const canReconnect =
    !timeUp && !ended && !termination && status === "error" && error !== null && !NOT_RETRYABLE.has(error);

  return (
    <div className="mt-6">
      <div className="flex flex-wrap items-center gap-3 text-sm" aria-live="polite">
        {status === "connecting" ? (
          <span className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Connecting to your interviewer…
          </span>
        ) : live ? (
          <span className="flex items-center gap-2">
            <span className="size-2 rounded-full bg-destructive motion-safe:animate-pulse" aria-hidden />
            Live
          </span>
        ) : status === "reconnecting" ? (
          <span className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Reconnecting… your answers are saved
          </span>
        ) : status === "closed" ? (
          <span className="text-muted-foreground">
            {termination ? "Interview ended" : ended ? "Interview complete" : timeUp ? "Interview time is over" : "Disconnected"}
          </span>
        ) : null}
        <span className="ml-auto font-mono tabular-nums text-muted-foreground" aria-label="Elapsed time">
          {formatClock(elapsed)}
        </span>
      </div>
      <ExaminingIndicator items={live ? examining : null} />

      {termination ? (
        <Notice tone="error">
          <span className="min-w-0 flex-1">{termination}</span>
          <Button asChild variant="outline" size="sm">
            <Link href={`/workspaces/${workspaceId}`}>Start another interview</Link>
          </Button>
        </Notice>
      ) : null}
      {warning && !termination ? (
        <Notice tone="error">
          <span className="min-w-0 flex-1">
            {warning.message}{" "}
            <span className="text-xs">
              (Warning {warning.number} of {INTEGRITY_WARNING_LIMIT - 1}. A third warning ends the interview.)
            </span>
          </span>
          <Button variant="ghost" size="sm" onClick={onDismissWarning}>
            Dismiss
          </Button>
        </Notice>
      ) : null}
      {status === "reconnecting" ? (
        <Notice tone="info">
          {pauseReason ? `${PAUSE_REASONS[pauseReason]}. ` : ""}
          Your voice time is paused and your answers are saved. Reconnecting automatically…
        </Notice>
      ) : null}
      {showResumed ? <Notice tone="success">Resumed from your last answer.</Notice> : null}
      {ended ? (
        <Notice tone="info">The interview is complete. Thanks for walking through your code. Taking you to your report…</Notice>
      ) : null}
      {wrappingUp && !ended ? (
        <Notice tone="info">Wrapping up: the interviewer will finish the current question.</Notice>
      ) : null}
      {timeUp ? <Notice tone="info">The voice session reached its time limit.</Notice> : null}
      {status === "error" && error ? (
        <Notice tone="error">{ROOM_ERRORS[error] ?? "Something went wrong with the voice session."}</Notice>
      ) : null}
      {canReconnect ? (
        <div className="mt-4">
          <Button onClick={onReconnect} variant="outline">
            Reconnect
          </Button>
        </div>
      ) : null}

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <TranscriptPane
          title="Interviewer"
          icon={<Bot className="size-4 text-brand" aria-hidden />}
          turns={transcript.ai}
          placeholder={live ? "The interviewer is about to speak…" : "The interviewer's words will appear here."}
        />
        <TranscriptPane
          title="You"
          icon={<Mic className="size-4" aria-hidden />}
          turns={transcript.user}
          placeholder={live ? "Listening…" : "Your answers will appear here."}
        />
      </div>
    </div>
  );
}
