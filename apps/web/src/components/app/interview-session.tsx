"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { type InterviewPlanning, type InterviewStreamEvent, PAUSE_RESUME_WINDOW_SECONDS } from "@stackprep/shared";
import { InterviewLobby } from "@/components/app/interview-lobby";
import { InterviewPaused } from "@/components/app/interview-paused";
import { InterviewRoom } from "@/components/app/interview-room";
import { useIntegrityMonitor } from "@/components/app/use-integrity-monitor";
import { useInterviewEvents } from "@/components/app/use-interview-events";
import { useInterviewMedia } from "@/components/app/use-interview-media";
import { useRealtimeInterview } from "@/components/app/use-realtime-interview";
import { pauseInterview, resumeInterview } from "@/lib/interview-events";

const PREPARING_RETRY_MS = 4000;
/** Leaves the closing notice on screen briefly before moving to the report. */
const REPORT_REDIRECT_MS = 3000;
/** A streamed completion waits this long for a live session's closing turn before ending the room. */
const STREAMED_COMPLETION_GRACE_MS = 30_000;

const PAUSE_ERRORS: Record<string, string> = {
  pause_limit_reached: "You have used all your pauses for this interview.",
  pause_expired: "This interview was paused for more than an hour, so it has ended.",
  interview_not_active: "This interview is no longer active.",
};

function pauseErrorMessage(code: string): string {
  return PAUSE_ERRORS[code] ?? "Something went wrong. Try again.";
}

/**
 * Lobby until the candidate enters, then the live room; the report once the interview ends.
 * Owns the interview's single camera + microphone stream, shared by the lobby check, the voice
 * session, and integrity monitoring. A candidate pause releases the devices; resuming goes back
 * through the backend before a new voice session opens.
 */
export function InterviewSession({
  interviewId,
  workspaceId,
  planning,
  pausedAt,
  pausesLeft: initialPausesLeft,
}: {
  interviewId: string;
  workspaceId: string;
  planning: InterviewPlanning | null;
  /** Set when the interview was already paused when the page loaded. */
  pausedAt: string | null;
  pausesLeft: number;
}) {
  const router = useRouter();
  const media = useInterviewMedia();
  const [entered, setEntered] = useState(false);
  const voice = useRealtimeInterview(interviewId, media);
  const { status, error, ended, timeUp, terminated, start, terminate, end, confirmTurn } = voice;
  const integrity = useIntegrityMonitor({
    interviewId,
    stream: media.stream,
    enabled: entered && voice.integrityReady,
    onTerminated: terminate,
  });

  /** When the pause must be resumed by; null while not paused. */
  const [resumeBy, setResumeBy] = useState<string | null>(() =>
    pausedAt ? new Date(Date.parse(pausedAt) + PAUSE_RESUME_WINDOW_SECONDS * 1000).toISOString() : null,
  );
  const [pausesLeft, setPausesLeft] = useState(initialPausesLeft);
  const [pauseBusy, setPauseBusy] = useState(false);
  const [pauseError, setPauseError] = useState<string | null>(null);
  const [pauseEnded, setPauseEnded] = useState(false);

  const { release } = media;
  const over = ended || timeUp || terminated;
  useEffect(() => {
    if (over) {
      release();
    }
  }, [over, release]);

  const [streamedCompletion, setStreamedCompletion] = useState(false);
  const [reportReady, setReportReady] = useState(false);
  const onStreamEvent = useCallback(
    (event: InterviewStreamEvent) => {
      if (event.event === "turn_persisted") {
        confirmTurn(event.data);
      } else if (event.event === "interview_status") {
        if (event.data.status === "terminated") {
          terminate();
        } else if (event.data.status === "completed") {
          setStreamedCompletion(true);
        }
      } else {
        setReportReady(true);
      }
    },
    [confirmTurn, terminate],
  );
  useInterviewEvents(interviewId, { enabled: entered, onEvent: onStreamEvent });

  // The relay normally ends the room after the closing turn; this covers completions it never saw
  // (the voice cap reached while disconnected, another tab), without cutting a closing turn short.
  const live = status === "live";
  useEffect(() => {
    if (!streamedCompletion || ended || terminated) {
      return;
    }
    if (!live) {
      end();
      return;
    }
    const id = window.setTimeout(end, STREAMED_COMPLETION_GRACE_MS);
    return () => window.clearTimeout(id);
  }, [streamedCompletion, ended, terminated, live, end]);

  useEffect(() => {
    if (reportReady && over) {
      router.push(`/interviews/${interviewId}/report`);
    }
  }, [reportReady, over, interviewId, router]);

  useEffect(() => {
    if (!ended) {
      return;
    }
    const id = window.setTimeout(() => router.push(`/interviews/${interviewId}/report`), REPORT_REDIRECT_MS);
    return () => window.clearTimeout(id);
  }, [ended, interviewId, router]);

  const preparing = entered && status === "error" && error === "interview_preparing";
  useEffect(() => {
    if (!preparing) {
      return;
    }
    const id = window.setTimeout(start, PREPARING_RETRY_MS);
    return () => window.clearTimeout(id);
  }, [preparing, start]);

  const { pause: closeForPause, resume: reopenAfterPause, paused: sessionPaused } = voice;
  const stopInterview = useCallback(async () => {
    setPauseBusy(true);
    setPauseError(null);
    const result = await pauseInterview(interviewId);
    setPauseBusy(false);
    if (!result.ok) {
      setPauseError(pauseErrorMessage(result.code));
      return;
    }
    closeForPause();
    release();
    setPausesLeft(result.body.pauses_left);
    setResumeBy(result.body.resume_by);
  }, [interviewId, closeForPause, release]);

  /** Resumes on the backend, then reopens the voice session (or the first one, from the lobby). */
  const resume = useCallback(async () => {
    setPauseBusy(true);
    setPauseError(null);
    const result = await resumeInterview(interviewId);
    setPauseBusy(false);
    if (!result.ok) {
      setPauseError(pauseErrorMessage(result.code));
      if (result.code === "pause_expired" || result.code === "interview_not_active") {
        setPauseEnded(true);
      }
      return;
    }
    setResumeBy(null);
    if (sessionPaused) {
      reopenAfterPause();
    } else {
      setEntered(true);
      start();
    }
  }, [interviewId, sessionPaused, reopenAfterPause, start]);

  if (resumeBy && (sessionPaused || !entered)) {
    if (!entered) {
      return (
        <InterviewLobby
          planning={planning}
          media={media}
          resume={{ resumeBy, busy: pauseBusy, error: pauseError, ended: pauseEnded, workspaceId }}
          onEnter={() => void resume()}
        />
      );
    }
    return (
      <InterviewPaused
        resumeBy={resumeBy}
        pausesLeft={pausesLeft}
        busy={pauseBusy}
        error={pauseError}
        ended={pauseEnded}
        workspaceId={workspaceId}
        onResume={() => void resume()}
      />
    );
  }

  if (!entered) {
    return (
      <InterviewLobby
        planning={planning}
        media={media}
        onEnter={() => {
          setEntered(true);
          start();
        }}
      />
    );
  }
  const canStop =
    !over && !terminated && voice.clock !== null && (status === "live" || status === "reconnecting" || status === "error");
  return (
    <InterviewRoom
      status={status}
      error={error}
      timeUp={timeUp}
      ended={ended}
      pauseReason={voice.pauseReason}
      resumed={voice.resumed}
      warning={integrity.warning}
      termination={terminated ? (integrity.termination ?? "The interview was ended after a third integrity warning.") : null}
      workspaceId={workspaceId}
      examining={voice.examining}
      clock={voice.clock}
      transcript={voice.transcript}
      stop={canStop ? { pausesLeft, busy: pauseBusy, error: pauseError, onStop: () => void stopInterview() } : null}
      onReconnect={voice.reconnect}
      onDismissWarning={integrity.dismissWarning}
    />
  );
}
