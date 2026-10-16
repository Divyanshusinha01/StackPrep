"use client";

import { useId } from "react";
import Link from "next/link";
import { CircleAlert, CircleCheck, Loader2, Mic, Video } from "lucide-react";
import type { InterviewPlanning, PlanningErrorCode } from "@stackprep/shared";
import { DEVICE_ERRORS } from "@/components/app/device-copy";
import { NO_REPORT_MESSAGE } from "@/components/app/end-interview";
import { type EndControl, useEndInterviewConfirm } from "@/components/app/end-interview-control";
import { DeviceStep, StepMarker } from "@/components/app/interview-lobby/device-step";
import { PreviewTile } from "@/components/app/interview-lobby/preview-tile";
import { formatResumeBy } from "@/components/app/interview-paused";
import { Notice } from "@/components/app/notice";
import { OpenAIKeyNotice } from "@/components/app/openai-key-notice";
import { useDeviceCheck } from "@/components/app/use-device-check";
import type { InterviewMedia } from "@/components/app/use-interview-media";
import { usePollWhile } from "@/components/app/use-poll-while";
import { CTA_GLOW } from "@/components/landing/constants";
import { Button } from "@/components/ui/button";
import { isOpenAIKeySetupCode } from "@/lib/openai-key-setup";
import { cn } from "@/lib/utils";

const PLANNING_ERRORS: Record<PlanningErrorCode, string> = {
  repository_memory_unavailable: "The repository analysis for this interview's commit is missing.",
  ai_rate_limited: "The interview planner is busy right now.",
  ai_unavailable: "The interview planner is unavailable right now.",
  ai_invalid_output: "The interview planner could not produce a plan.",
  enqueue_failed: "Interview preparation could not be started.",
  internal_error: "Something went wrong while preparing the interview.",
  openai_key_unavailable: "No working OpenAI key was available to prepare this interview.",
  openai_key_invalid: "Your OpenAI key was rejected while preparing this interview.",
  openai_quota_exhausted: "Your OpenAI account ran out of quota while preparing this interview.",
};

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
  workspaceId,
  resume,
  onEnter,
}: {
  planning: InterviewPlanning | null;
  media: InterviewMedia;
  workspaceId: string;
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

        <PreviewTile
          videoRef={videoRef}
          phase={phase}
          cameraOk={cameraOk}
          onStart={() => void start()}
          onVideoLoaded={onVideoLoaded}
        />

        <p className="sr-only" aria-live="polite">
          {[cameraOk ? "Camera detected." : "", micOk ? "Microphone detected." : ""].join(" ").trim()}
        </p>
        <ol className="mt-5 divide-y divide-border/70 rounded-lg border bg-background/40 px-4">
          <DeviceStep
            step={1}
            ok={cameraOk}
            waiting={checking}
            icon={<Video className="size-4" aria-hidden />}
            label="Camera"
          />
          <DeviceStep
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
                className="h-full origin-left scale-x-0 bg-gradient-to-r from-success/80 via-success to-brand transition-transform duration-75"
              />
              <div className="pointer-events-none absolute inset-0 bg-[repeating-linear-gradient(to_right,transparent_0,transparent_8px,var(--background)_8px,var(--background)_10px)] opacity-60" />
            </div>
          </DeviceStep>
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
          {planFailed && isOpenAIKeySetupCode(planning.error_code) ? (
            <OpenAIKeyNotice
              code={planning.error_code}
              returnTo={`/workspaces/${workspaceId}`}
              detail="Once the key works, Settings takes you back to the workspace to start a new interview."
              className="mt-3"
            />
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
              blocker ? "text-muted-foreground" : "text-success",
            )}
          >
            {blocker ? (
              <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
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
