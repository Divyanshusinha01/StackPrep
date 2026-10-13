"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AnimatePresence, m } from "framer-motion";
import { Bot, FileSearch, Loader2, Mic, Pause, RotateCw } from "lucide-react";
import {
  INTEGRITY_WARNING_LIMIT,
  MAX_INTERVIEW_PAUSES,
  PAUSE_RESUME_WINDOW_SECONDS,
  type PauseReason,
  VOICE_WRAP_UP_SECONDS,
} from "@stackprep/shared";
import { type EndControl, useEndInterviewConfirm } from "@/components/app/end-interview-control";
import { type ExaminedItem, examiningLabel } from "@/components/app/examining";
import { Notice } from "@/components/app/notice";
import type { TranscriptTurn } from "@/components/app/realtime-transcript";
import { StatusChip } from "@/components/app/status-chip";
import type { IntegrityWarning } from "@/components/app/use-integrity-monitor";
import {
  NOT_RETRYABLE,
  type RealtimeErrorCode,
  type RealtimeStatus,
  type VoiceClock,
} from "@/components/app/use-realtime-interview";
import { MotionProvider } from "@/components/motion/motion-provider";
import { useReducedMotion } from "@/components/motion/use-reduced-motion";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const ROOM_ERRORS: Partial<Record<RealtimeErrorCode, string>> = {
  microphone_denied: "Camera or microphone access was blocked. Allow access in your browser settings and reconnect.",
  microphone_unavailable: "No working camera or microphone was found. Connect them and reconnect.",
  connection_failed: "Could not connect to the voice interviewer. Check your connection and try again.",
  connection_lost:
    "We could not reconnect automatically. Your voice time is paused and your answers are saved; reconnect to continue.",
  idle_timeout:
    "We didn't hear anything for 3 minutes, so the voice session was closed. Your voice time is paused and your answers are saved; reconnect when you're ready.",
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

export interface StopControl {
  pausesLeft: number;
  busy: boolean;
  error: string | null;
  onStop: () => void;
}

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

/** Three bouncing bars while someone is talking; a still dot otherwise. Decorative only. */
function VoiceActivity({ active, label }: { active: boolean; label: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors",
        active ? "bg-brand-muted text-brand" : "text-muted-foreground",
      )}
    >
      <span aria-hidden className="flex h-3 items-end gap-[2px]">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className={cn(
              "w-[3px] origin-bottom rounded-full bg-current",
              active ? "h-3 motion-safe:animate-[wave_0.9s_ease-in-out_infinite]" : "h-1",
            )}
            style={active ? { animationDelay: `${i * 0.15}s` } : undefined}
          />
        ))}
      </span>
      {label}
    </span>
  );
}

function TranscriptPane({
  title,
  icon,
  turns,
  placeholder,
  side,
  activity,
  overlay,
}: {
  title: string;
  icon: React.ReactNode;
  turns: TranscriptTurn[];
  placeholder: string;
  side: "ai" | "user";
  /** Speaking indicator in the pane header. */
  activity: React.ReactNode;
  /** Pinned over the bottom of the log, such as the "Examining …" chip. */
  overlay?: React.ReactNode;
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
    <section
      aria-labelledby={id}
      className="surface-inset relative flex min-h-0 flex-col overflow-hidden rounded-xl border bg-panel/60"
    >
      <div className="flex items-center justify-between gap-3 border-b bg-panel-raised/40 px-4 py-3">
        <h2 id={id} className="flex items-center gap-2 font-display text-sm font-semibold tracking-tight">
          {icon}
          {title}
        </h2>
        {activity}
      </div>
      <div
        ref={scrollRef}
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
        onScroll={(e) => {
          const el = e.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
        className={cn(
          "flex min-h-0 flex-1 flex-col divide-y divide-border/50 overflow-y-auto overscroll-contain px-4 py-2 text-sm leading-relaxed",
          overlay !== undefined && "pb-14",
        )}
      >
        {turns.length === 0 ? (
          <p className="m-auto max-w-xs py-8 text-center text-sm text-muted-foreground">{placeholder}</p>
        ) : null}
        {turns.map((turn, index) => {
          const isLatest = index === turns.length - 1;
          return (
            <div
              key={turn.itemId}
              className={cn(
                "py-3.5 first:pt-2 last:pb-2",
                isLatest ? "text-foreground" : "text-foreground/80",
              )}
            >
              <div
                className={cn(
                  "border-l-2 pl-3.5 transition-colors",
                  side === "ai"
                    ? isLatest
                      ? "border-brand"
                      : "border-brand/35"
                    : isLatest
                      ? "border-foreground/60"
                      : "border-border-strong",
                  !turn.final && "text-foreground/75",
                )}
              >
                <p className="break-words">
                  {turn.text || <span className="text-muted-foreground">…</span>}
                  {turn.interrupted ? (
                    <span className="ml-1.5 font-mono text-xs text-muted-foreground">(cut off)</span>
                  ) : null}
                </p>
              </div>
            </div>
          );
        })}
      </div>
      {overlay}
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
      className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-start p-2.5"
    >
      {label ? (
        <span className="pointer-events-auto inline-flex max-w-full items-center gap-2 rounded-lg border border-brand/35 bg-background/95 px-3 py-1.5 text-xs text-foreground shadow-lg shadow-black/40 backdrop-blur-md motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1">
          <FileSearch className="size-3.5 shrink-0 text-brand" aria-hidden />
          <span className="truncate font-mono text-[11px]">{label}</span>
        </span>
      ) : null}
    </p>
  );
}

/** Notices over the top of the transcripts, so they come and go without moving the layout. */
function BannerStack({ items }: { items: { key: string; node: React.ReactNode }[] }) {
  const reduced = useReducedMotion();
  return (
    <MotionProvider>
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex flex-col gap-2 p-2 sm:p-3">
        <AnimatePresence initial={false}>
          {items.map(({ key, node }) => (
            <m.div
              key={key}
              initial={reduced ? false : { opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduced ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: -6 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
              className="pointer-events-auto rounded-lg bg-background/90 shadow-lg shadow-black/40 backdrop-blur-md [&>*]:mt-0 [&>*+*]:mt-2"
            >
              {node}
            </m.div>
          ))}
        </AnimatePresence>
      </div>
    </MotionProvider>
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
  stop,
  endControl,
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
  /** Candidate pause; null while the interview cannot be paused. */
  stop: StopControl | null;
  /** Candidate ends the interview with a report; null while it cannot be ended. */
  endControl: EndControl | null;
  onReconnect: () => void;
  onDismissWarning: () => void;
}) {
  const [confirmingStop, setConfirmingStop] = useState(false);
  const ending = useEndInterviewConfirm(endControl, confirmingStop || Boolean(stop?.busy));
  const live = status === "live";
  const elapsed = useElapsed(clock, live);
  const wrappingUp = live && elapsed >= VOICE_WRAP_UP_SECONDS;
  const showResumed = useBriefly(resumed && live, RESUMED_NOTICE_MS);
  const canReconnect =
    !timeUp && !ended && !termination && status === "error" && error !== null && !NOT_RETRYABLE.has(error);

  const lastAi = transcript.ai[transcript.ai.length - 1];
  const lastUser = transcript.user[transcript.user.length - 1];
  const aiSpeaking = live && lastAi !== undefined && !lastAi.final;
  const userSpeaking = live && lastUser !== undefined && !lastUser.final;

  const banners: { key: string; node: React.ReactNode }[] = [];
  if (termination) {
    banners.push({
      key: "termination",
      node: (
        <Notice tone="error">
          <span className="min-w-0 flex-1">{termination}</span>
          <Button asChild variant="outline" size="sm">
            <Link href={`/workspaces/${workspaceId}`}>Start another interview</Link>
          </Button>
        </Notice>
      ),
    });
  }
  if (status === "error" && error) {
    banners.push({
      key: `error-${error}`,
      node: (
        <Notice tone="error">
          <span className="min-w-0 flex-1">{ROOM_ERRORS[error] ?? "Something went wrong with the voice session."}</span>
          {canReconnect ? (
            <Button onClick={onReconnect} variant="outline" size="sm">
              <RotateCw aria-hidden />
              Reconnect
            </Button>
          ) : null}
        </Notice>
      ),
    });
  }
  if (warning && !termination) {
    banners.push({
      key: `warning-${warning.number}`,
      node: (
        <Notice tone="warning">
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
      ),
    });
  }
  if (status === "reconnecting") {
    banners.push({
      key: "reconnecting",
      node: (
        <Notice tone="info" icon={false}>
          <Loader2 className="size-4 shrink-0 motion-safe:animate-spin text-brand" aria-hidden />
          <span className="min-w-0 flex-1">
            {pauseReason ? `${PAUSE_REASONS[pauseReason]}. ` : ""}
            Your voice time is paused and your answers are saved. Reconnecting automatically…
          </span>
        </Notice>
      ),
    });
  }
  if (stop && confirmingStop) {
    banners.push({
      key: "stop-confirm",
      node: (
        <Notice tone="info">
          <span className="min-w-0 flex-1">
            Stop for now? Your answers are saved and your voice time stops. Resume within{" "}
            {PAUSE_RESUME_WINDOW_SECONDS / 60} minutes or the interview ends.{" "}
            <span className="text-xs">
              ({stop.pausesLeft} of {MAX_INTERVIEW_PAUSES} {stop.pausesLeft === 1 ? "pause" : "pauses"} left.)
            </span>
          </span>
          <Button
            size="sm"
            disabled={stop.busy}
            onClick={() => {
              setConfirmingStop(false);
              stop.onStop();
            }}
          >
            Stop interview
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setConfirmingStop(false)}>
            Keep going
          </Button>
        </Notice>
      ),
    });
  }
  if (stop?.busy) {
    banners.push({
      key: "stop-busy",
      node: (
        <Notice tone="info" icon={false}>
          <Loader2 className="size-4 shrink-0 motion-safe:animate-spin text-brand" aria-hidden />
          Pausing…
        </Notice>
      ),
    });
  }
  if (stop?.error) {
    banners.push({ key: "stop-error", node: <Notice tone="error">{stop.error}</Notice> });
  }
  if (endControl && (ending.confirming || endControl.busy || endControl.error)) {
    banners.push({ key: "end", node: ending.panel });
  }
  if (ended) {
    banners.push({
      key: "ended",
      node: (
        <Notice tone="success">
          The interview is complete. Thanks for walking through your code. Taking you to your report…
        </Notice>
      ),
    });
  }
  if (wrappingUp && !ended) {
    banners.push({
      key: "wrap-up",
      node: <Notice tone="info">Wrapping up: the interviewer will finish the current question.</Notice>,
    });
  }
  if (timeUp) {
    banners.push({ key: "time-up", node: <Notice tone="info">The voice session reached its time limit.</Notice> });
  }
  if (showResumed) {
    banners.push({ key: "resumed", node: <Notice tone="success">Resumed from your last answer.</Notice> });
  }

  return (
    <div>
      <div className="sticky top-[var(--app-header-h)] z-30 -mx-4 border-b border-border/80 bg-background/90 px-4 py-3 backdrop-blur-md sm:-mx-6 sm:px-6">
        <div className="flex items-center gap-3.5 text-sm">
          <span aria-live="polite" className="flex min-w-0 items-center">
            {status === "connecting" ? (
              <span className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="size-4 shrink-0 motion-safe:animate-spin text-brand" aria-hidden />
                <span className="truncate">Connecting to your interviewer…</span>
              </span>
            ) : live ? (
              <StatusChip tone="danger" pulse className="font-semibold tracking-wide">
                Live
              </StatusChip>
            ) : status === "reconnecting" ? (
              <span className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="size-4 shrink-0 motion-safe:animate-spin text-brand" aria-hidden />
                <span className="truncate">Reconnecting… your answers are saved</span>
              </span>
            ) : status === "closed" ? (
              <span className="truncate text-muted-foreground">
                {termination ? "Interview ended" : ended ? "Interview complete" : timeUp ? "Interview time is over" : "Disconnected"}
              </span>
            ) : null}
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
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setConfirmingStop(true)}
                  disabled={stop.busy || confirmingStop || ending.confirming || Boolean(endControl?.busy)}
                >
                  <Pause className="size-3.5" aria-hidden />
                  <span className="max-sm:sr-only">Stop interview</span>
                </Button>
              ) : (
                <span className="hidden font-mono text-xs text-muted-foreground sm:inline">No pauses left</span>
              )
            ) : null}
            {ending.button}
          </div>
        </div>
      </div>

      <div className="relative mt-4">
        <BannerStack items={banners} />
        <div className="grid h-[calc(100dvh-var(--app-header-h)-8rem)] min-h-[28rem] grid-rows-2 gap-4 md:min-h-[24rem] md:grid-cols-2 md:grid-rows-1">
          <TranscriptPane
            title="Interviewer"
            icon={<Bot className="size-4 text-brand" aria-hidden />}
            turns={transcript.ai}
            side="ai"
            placeholder={live ? "The interviewer is about to speak…" : "The interviewer's words will appear here."}
            activity={live ? <VoiceActivity active={aiSpeaking} label={aiSpeaking ? "Speaking" : "Waiting"} /> : null}
            overlay={<ExaminingIndicator items={live ? examining : null} />}
          />
          <TranscriptPane
            title="You"
            icon={<Mic className="size-4" aria-hidden />}
            turns={transcript.user}
            side="user"
            placeholder={live ? "Listening…" : "Your answers will appear here."}
            activity={live ? <VoiceActivity active={userSpeaking} label={userSpeaking ? "Speaking" : "Mic on"} /> : null}
          />
        </div>
      </div>
    </div>
  );
}
