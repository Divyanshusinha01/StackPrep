"use client";

import { Check, Circle, Loader2, Mic, Video } from "lucide-react";
import type { InterviewPlanning, PlanningErrorCode } from "@stackprep/shared";
import { Notice } from "@/components/app/notice";
import { type DeviceError, useDeviceCheck } from "@/components/app/use-device-check";
import { usePollWhile } from "@/components/app/use-poll-while";
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

function CheckItem({ ok, icon, label, hint }: { ok: boolean; icon: React.ReactNode; label: string; hint?: string }) {
  return (
    <li className={cn("flex items-center gap-2", ok ? "text-foreground" : "text-muted-foreground")}>
      {ok ? <Check className="size-4 text-emerald-300" aria-hidden /> : <Circle className="size-4" aria-hidden />}
      {icon}
      <span>{label}</span>
      {!ok && hint ? <span className="text-xs">{hint}</span> : null}
      <span className="sr-only">{ok ? "(passed)" : "(not yet passed)"}</span>
    </li>
  );
}

export function InterviewLobby({ planning }: { planning: InterviewPlanning | null }) {
  const { videoRef, meterRef, phase, error, cameraOk, micOk, start, onVideoLoaded } = useDeviceCheck();
  const preparing = planning === null || planning.state === "queued" || planning.state === "running";
  const planReady = planning?.state === "succeeded";
  usePollWhile(preparing);

  const devicesOk = cameraOk && micOk;

  return (
    <div className="mt-6 grid gap-6 md:grid-cols-[minmax(0,1fr)_18rem]">
      <section aria-labelledby="device-check" className="rounded-md border border-border bg-panel/60 p-4">
        <h2 id="device-check" className="text-sm font-medium">
          Camera and microphone check
        </h2>
        <div className="relative mt-3 aspect-video overflow-hidden rounded-md bg-black/60">
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
            <div className="absolute inset-0 flex items-center justify-center">
              <Button onClick={start} disabled={phase === "requesting"} variant="outline">
                {phase === "requesting" ? "Waiting for permission…" : phase === "error" ? "Try again" : "Start check"}
              </Button>
            </div>
          ) : null}
        </div>
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-border" aria-hidden>
          <div ref={meterRef} className="h-full origin-left scale-x-0 bg-emerald-400 transition-transform duration-75" />
        </div>
        <ul className="mt-3 space-y-2 text-sm">
          <CheckItem ok={cameraOk} icon={<Video className="size-4" aria-hidden />} label="Camera" />
          <CheckItem
            ok={micOk}
            icon={<Mic className="size-4" aria-hidden />}
            label="Microphone"
            hint={phase === "active" ? "Say a few words" : undefined}
          />
        </ul>
        {error ? <Notice tone="error">{DEVICE_ERRORS[error]}</Notice> : null}
      </section>

      <aside className="flex flex-col gap-4">
        <section aria-labelledby="planning-status" aria-live="polite" className="rounded-md border border-border bg-panel/60 p-4">
          <h2 id="planning-status" className="text-sm font-medium">
            Interview plan
          </h2>
          <p className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
            {preparing ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden />
                Preparing your interview…
              </>
            ) : planReady ? (
              <>
                <Check className="size-4 text-emerald-300" aria-hidden />
                Ready
              </>
            ) : null}
          </p>
          {planning?.state === "failed" ? (
            <Notice tone="error">
              {PLANNING_ERRORS[planning.error_code ?? "internal_error"]} Start a new interview from the workspace.
            </Notice>
          ) : null}
        </section>

        <Button disabled aria-disabled size="lg">
          Enter interview
        </Button>
        <p className="text-xs text-muted-foreground">
          {!devicesOk
            ? "Complete the camera and microphone check to continue."
            : preparing
              ? "Preparing… you can enter once the plan is ready."
              : planReady
                ? "Ready. The live interview is not available yet."
                : "This interview could not be prepared."}
        </p>
      </aside>
    </div>
  );
}
