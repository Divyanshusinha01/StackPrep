"use client";

import { useState } from "react";
import Link from "next/link";
import { Bot, Loader2, Mic, RotateCw } from "lucide-react";
import { INTEGRITY_WARNING_LIMIT, type PauseReason, VOICE_WRAP_UP_SECONDS } from "@stackprep/shared";
import { type EndControl, useEndInterviewConfirm } from "@/components/app/end-interview-control";
import type { ExaminedItem } from "@/components/app/examining";
import { type Banner, BannerStack } from "@/components/app/interview-room/banner-stack";
import { ExaminingIndicator } from "@/components/app/interview-room/examining-indicator";
import { PAUSE_REASONS, ROOM_ERRORS, SYNC_ERROR_MESSAGE } from "@/components/app/interview-room/room-copy";
import { RoomStatusBar, type StopControl } from "@/components/app/interview-room/room-status-bar";
import { TranscriptPane } from "@/components/app/interview-room/transcript-pane";
import { useBriefly, useElapsed } from "@/components/app/interview-room/use-elapsed";
import { VoiceActivity } from "@/components/app/interview-room/voice-activity";
import { Notice } from "@/components/app/notice";
import { OpenAIKeyNotice } from "@/components/app/openai-key-notice";
import type { TranscriptTurn } from "@/components/app/realtime-transcript";
import type { IntegrityWarning } from "@/components/app/use-integrity-monitor";
import {
  NOT_RETRYABLE,
  type RealtimeErrorCode,
  type RealtimeStatus,
  type VoiceClock,
} from "@/components/app/use-realtime-interview";
import { Button } from "@/components/ui/button";
import { isOpenAIKeySetupCode } from "@/lib/openai-key-setup";

export type { StopControl };

/** How long "Resumed" stays on screen after a reconnect. */
const RESUMED_NOTICE_MS = 6000;

export function InterviewRoom({
  status,
  error,
  timeUp,
  ended,
  pauseReason,
  resumed,
  warning,
  termination,
  interviewId,
  workspaceId,
  examining,
  clock,
  transcript,
  syncError,
  stop,
  endControl,
  onReconnect,
  onDismissWarning,
}: {
  status: RealtimeStatus;
  interviewId: string;
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
  /** Set when an interview update could not be saved and was dropped. */
  syncError: string | null;
  /** Candidate pause; null while the interview cannot be paused. */
  stop: StopControl | null;
  /** Candidate ends the interview with a report; null while it cannot be ended. */
  endControl: EndControl | null;
  onReconnect: () => void;
  onDismissWarning: () => void;
}) {
  const [confirmingStop, setConfirmingStop] = useState(false);
  const [dismissedSyncError, setDismissedSyncError] = useState<string | null>(null);
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

  const banners: Banner[] = [];
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
  if (status === "error" && error && isOpenAIKeySetupCode(error)) {
    banners.push({
      key: `error-${error}`,
      node: (
        <OpenAIKeyNotice
          code={error}
          returnTo={`/interviews/${interviewId}`}
          detail="Your answers are saved and your voice time is paused. Fix the key, then come back here to continue the interview."
        />
      ),
    });
  } else if (status === "error" && error) {
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
  if (endControl && (endControl.busy || endControl.error)) {
    banners.push({ key: "end", node: ending.panel });
  }
  if (syncError && syncError !== dismissedSyncError && !ended && !termination) {
    banners.push({
      key: "sync-error",
      node: (
        <Notice tone="warning">
          <span className="min-w-0 flex-1">{SYNC_ERROR_MESSAGE}</span>
          <Button variant="ghost" size="sm" onClick={() => setDismissedSyncError(syncError)}>
            Dismiss
          </Button>
        </Notice>
      ),
    });
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
      <RoomStatusBar
        status={status}
        error={error}
        termination={Boolean(termination)}
        ended={ended}
        timeUp={timeUp}
        elapsed={elapsed}
        wrappingUp={wrappingUp}
        stop={stop}
        confirmingStop={confirmingStop}
        onConfirmingStopChange={setConfirmingStop}
        stopDisabled={Boolean(stop?.busy) || ending.confirming || Boolean(endControl?.busy)}
        endButton={ending.button}
      />

      <div className="relative mt-4">
        <BannerStack items={banners} />
        <div className="grid h-[calc(100dvh-var(--app-header-h)-8rem)] min-h-[28rem] grid-rows-2 gap-4 md:min-h-[24rem] md:grid-cols-2 md:grid-rows-1">
          <TranscriptPane
            title="Interviewer"
            icon={<Bot className="size-4 text-brand" aria-hidden />}
            turns={transcript.ai}
            side="ai"
            latestLabel={live ? "Current question" : undefined}
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
