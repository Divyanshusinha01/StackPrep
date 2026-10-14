"use client";

import { useId } from "react";
import Link from "next/link";
import { Check, CircleAlert, CircleCheck, Loader2, Mic, Video, X } from "lucide-react";
import type { InterviewPlanning, PlanningErrorCode } from "@stackprep/shared";
import { NO_REPORT_MESSAGE } from "@/components/app/end-interview";
import { type EndControl, useEndInterviewConfirm } from "@/components/app/end-interview-control";
import { formatResumeBy } from "@/components/app/interview-paused";
import { Notice } from "@/components/app/notice";
import { type DeviceError, useDeviceCheck } from "@/components/app/use-device-check";
import type { InterviewMedia } from "@/components/app/use-interview-media";
import { usePollWhile } from "@/components/app/use-poll-while";
import { CTA_GLOW } from "@/components/landing/constants";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const DEVICE_ERRORS: Record<DeviceError, string> = {
  denied: "Camera or microphone access was blocked. Allow access in your browser settings and try again.",
  not_found: "No camera or microphone was found. Connect one and try again.",
  unsupported: "This browser cannot access a camera and microphone. Use a recent desktop browser.",
  failed: "The camera or microphone stopped working. Check your devices and try again.",
};

const PLANNING_ERRORS: Record<PlanningErrorCode, string> = {
  repository_memory_unavailable: "The repository analysis for this interview's commit is missing.",
  ai_rate_limited: "The interview planner is busy right now.",
  ai_unavailable: "The interview planner is unavailable right now.",
  ai_invalid_output: "The interview planner could not produce a plan.",
  enqueue_failed: "Interview preparation could not be started.",
  internal_error: "Something went wrong while preparing the interview.",
};

type StepState = "pending" | "active" | "done" | "failed";

/** Numbered circle for one lobby step; turns into a check, spinner or cross as the step progresses. */
function StepMarker({ step, state }: { step: number; state: StepState }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-7 shrink-0 place-items-center rounded-full border text-xs font-semibold tabular-nums transition-colors",
        state === "done" && "border-emerald-500/40 bg-emerald-500/15 text-emerald-300",
        state === "active" && "border-brand/50 bg-brand-muted text-brand",
        state === "failed" && "border-red-500/40 bg-red-500/15 text-red-300",
        state === "pending" && "border-border text-muted-foreground",
      )}
    >
      {state === "done" ? (
        <Check className="size-3.5" />
      ) : state === "active" ? (
        <Loader2 className="size-3.5 motion-safe:animate-spin" />
      ) : state === "failed" ? (
        <X className="size-3.5" />
      ) : (
        step
      )}
    </span>
  );
}

function CheckItem({
  step,
  ok,
  waiting,
  icon,
  label,
  hint,
  children,
}: {
  step: number;
  ok: boolean;
  /** The check is running but has not passed yet. */
  waiting: boolean;
  icon: React.ReactNode;
  label: string;
  hint?: string;
  children?: React.ReactNode;
}) {
  return (
    <li className="flex gap-3 py-3.5">
      <StepMarker step={step} state={ok ? "done" : waiting ? "active" : "pending"} />
      <div className="min-w-0 flex-1 pt-0.5">
        <p className={cn("flex items-center gap-2 text-sm font-medium", ok ? "text-foreground" : "text-muted-foreground")}>
          {icon}
          <span>{label}</span>
          {!ok && hint ? <span className="text-xs font-normal">{hint}</span> : null}
          <span className="sr-only">{ok ? "(passed)" : "(not yet passed)"}</span>
        </p>
        {children}
      </div>
    </li>
  );
}

export interface LobbyResume {
  resumeBy: string;
  busy: boolean;
  error: string | null;
  /** The pause can no longer be resumed. */
  ended: boolean;
  /** The candidate ended it before any answer was evaluated. */
  endedWithoutReport: boolean;
  /** Candidate ends the interview with a report; null once it has ended. */
  end: EndControl | null;
  workspaceId: string;
}

export function InterviewLobby({
  planning,
  media,
  resume,
  onEnter,
}: {
  planning: InterviewPlanning | null;
  media: InterviewMedia;
  /** Set when the candidate is coming back to a paused interview. */
  resume?: LobbyResume;
  onEnter: () => void;
}) {
  const { videoRef, meterRef, phase, error, cameraOk, micOk, start, onVideoLoaded } = useDeviceCheck(media);
  const preparing = planning === null || planning.state === "queued" || planning.state === "running";
  const planReady = planning?.state === "succeeded";
  const planFailed = planning?.state === "failed";
  usePollWhile(preparing);
  const hintId = useId();

  const ending = useEndInterviewConfirm(resume?.end ?? null, resume?.busy);
  const devicesOk = cameraOk && micOk;
  const canEnter = devicesOk && planReady && !resume?.busy && !resume?.ended && !ending.confirming;
  const checking = phase === "active";

  const blocker = resume?.ended
    ? "This interview can no longer be resumed."
    : phase === "error"
      ? "Fix the camera or microphone problem, then try the check again."
      : !devicesOk
        ? checking && cameraOk
          ? "Say a few words so the microphone check can pass."
          : "Complete the camera and microphone check to continue."
        : preparing
          ? "Preparing… you can enter once the plan is ready."
          : !planReady
            ? "This interview could not be prepared."
            : null;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <section aria-labelledby="device-check" className="surface-inset rounded-xl border bg-panel/60 p-5 sm:p-6">
        <div className="flex items-baseline justify-between gap-3">
          <div>
            <h2 id="device-check" className="font-display text-base font-semibold tracking-tight">
              Camera and microphone check
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">Both are required for the interview.</p>
          </div>
          <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
            {[cameraOk, micOk].filter(Boolean).length}/2 verified
          </span>
        </div>

        <div className="relative mt-4 aspect-video overflow-hidden rounded-lg border border-border-strong/70 bg-black/80 shadow-inner">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            onLoadedData={onVideoLoaded}
            className={cn("size-full -scale-x-100 object-cover", phase !== "active" && "invisible")}
            aria-label="Camera preview"
          />
          {phase !== "active" ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3.5 bg-radial from-panel/80 to-black/90 p-4 text-center">
              <span
                aria-hidden
                className="grid size-12 place-items-center rounded-xl border border-brand/25 bg-brand-muted/70 text-brand"
              >
                <Video className="size-5" />
              </span>
              <Button onClick={() => void start()} disabled={phase === "requesting"} variant="outline">
                {phase === "requesting" ? "Waiting for permission…" : phase === "error" ? "Try again" : "Start check"}
              </Button>
            </div>
          ) : null}
          {checking && cameraOk ? (
            <span className="absolute top-3 left-3 inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-black/70 px-2.5 py-0.5 font-mono text-[11px] text-emerald-300 backdrop-blur-md">
              <span aria-hidden className="size-1.5 rounded-full bg-emerald-400" />
              Preview on
            </span>
          ) : null}
        </div>

        <ol className="mt-5 divide-y divide-border/70 rounded-lg border bg-background/40 px-4">
          <CheckItem
            step={1}
            ok={cameraOk}
            waiting={checking}
            icon={<Video className="size-4" aria-hidden />}
            label="Camera"
          />
          <CheckItem
            step={2}
            ok={micOk}
            waiting={checking}
            icon={<Mic className="size-4" aria-hidden />}
            label="Microphone"
            hint={checking ? "Say a few words" : undefined}
          >
            <div
              aria-hidden
              className="relative mt-2.5 h-2.5 overflow-hidden rounded-full border border-border-strong/60 bg-muted/50"
            >
              <div
                ref={meterRef}
                className="h-full origin-left scale-x-0 bg-gradient-to-r from-emerald-500 via-emerald-400 to-brand transition-transform duration-75"
              />
              <div className="pointer-events-none absolute inset-0 bg-[repeating-linear-gradient(to_right,transparent_0,transparent_8px,var(--background)_8px,var(--background)_10px)] opacity-60" />
            </div>
          </CheckItem>
        </ol>
        {error ? <Notice tone="error">{DEVICE_ERRORS[error]}</Notice> : null}
        <p data-testid="media-disclosure" className="mt-4 text-xs leading-relaxed text-muted-foreground">
          During the interview, one low-detail camera frame is analyzed about every 10 seconds for integrity
          signals. Frames are discarded; only the signals are saved, never the images. Your audio is processed
          in real time and not retained. Both are processed by a third-party AI provider (OpenAI). See the{" "}
          <Link href="/privacy" className="focus-ring rounded-sm text-foreground/85 underline underline-offset-4 hover:text-foreground">
            Privacy Policy
          </Link>
          .
        </p>
      </section>

      <aside className="surface-inset flex flex-col divide-y self-start overflow-hidden rounded-xl border bg-panel/60">
        <section aria-labelledby="planning-status" aria-live="polite" className="p-5">
          <div className="flex gap-3">
            <StepMarker step={3} state={planReady ? "done" : planFailed ? "failed" : "active"} />
            <div className="min-w-0 pt-0.5">
              <h2 id="planning-status" className="font-display text-sm font-semibold">
                Interview plan
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {preparing ? "Preparing your interview…" : planReady ? "Ready" : null}
              </p>
            </div>
          </div>
          {planFailed ? (
            <Notice tone="error" className="mt-4">
              {PLANNING_ERRORS[planning.error_code ?? "internal_error"]} Start a new interview from the workspace.
            </Notice>
          ) : null}
        </section>

        {resume ? (
          <section aria-labelledby="pause-status" className="p-5">
            <h2 id="pause-status" className="font-display text-sm font-semibold">
              Paused
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              Your answers are saved. Resume by{" "}
              <span className="font-mono text-xs text-foreground" suppressHydrationWarning>
                {formatResumeBy(resume.resumeBy)}
              </span>{" "}
              to continue where you left off.
            </p>
            {resume.error ? <Notice tone="error">{resume.error}</Notice> : null}
            {resume.endedWithoutReport ? <Notice tone="info">{NO_REPORT_MESSAGE}</Notice> : null}
            {ending.panel}
            {ending.button ? <div className="mt-3">{ending.button}</div> : null}
            {resume.ended ? (
              <Button asChild variant="outline" size="sm" className="mt-3">
                <Link href={`/workspaces/${resume.workspaceId}`}>Back to workspace</Link>
              </Button>
            ) : null}
          </section>
        ) : null}

        <div className="bg-panel-raised/30 p-5">
          <Button
            disabled={!canEnter}
            onClick={onEnter}
            size="lg"
            aria-describedby={hintId}
            className={cn("w-full", canEnter && CTA_GLOW)}
          >
            {resume?.busy && !resume.end?.busy ? <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden /> : null}
            {resume ? "Resume interview" : "Enter interview"}
          </Button>
          <p
            id={hintId}
            className={cn(
              "mt-3.5 flex items-start gap-2 text-xs leading-relaxed",
              blocker ? "text-muted-foreground" : "text-emerald-300",
            )}
          >
            {blocker ? (
              <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-300" aria-hidden />
            ) : (
              <CircleCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            )}
            <span>
              {blocker ??
                (resume
                  ? "Ready. The interviewer will pick up from your last answer."
                  : "Ready. The interviewer will speak first; answer out loud.")}
            </span>
          </p>
        </div>
      </aside>
    </div>
  );
}
