"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { type InterviewPlanning, type InterviewStreamEvent, PAUSE_RESUME_WINDOW_SECONDS } from "@stackprep/shared";
import { endErrorMessage, endInterviewInOrder, NO_REPORT_MESSAGE } from "@/components/app/end-interview";
import { InterviewLobby } from "@/components/app/interview-lobby";
import { InterviewPaused } from "@/components/app/interview-paused";
import { InterviewRoom } from "@/components/app/interview-room";
import { useIntegrityMonitor } from "@/components/app/use-integrity-monitor";
import { useInterviewEvents } from "@/components/app/use-interview-events";
import { track } from "@/lib/analytics";
import { useInterviewMedia } from "@/components/app/use-interview-media";
import { useRealtimeInterview } from "@/components/app/use-realtime-interview";
import { endInterview, pauseInterview, resumeInterview } from "@/lib/interview-events";

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
  /** Resuming from an in-room pause goes back through the camera and microphone check. */
  const [recheckingDevices, setRecheckingDevices] = useState(false);
  const [endBusy, setEndBusy] = useState(false);
  const [endError, setEndError] = useState<string | null>(null);
  /** The candidate ended the interview before any answer was evaluated. */
  const [endedWithoutReport, setEndedWithoutReport] = useState(false);

  const { release } = media;
  const over = ended || timeUp || terminated || endedWithoutReport;
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
    setRecheckingDevices(false);
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
    setRecheckingDevices(false);
    if (sessionPaused) {
      reopenAfterPause();
    } else {
      setEntered(true);
      start();
    }
  }, [interviewId, sessionPaused, reopenAfterPause, start]);

  const { closeForEnd, flushOutbox } = voice;
  const onPausedScreen = Boolean(resumeBy) && (sessionPaused || !entered);
  /** Candidate ends the interview: from the room it shows the closing notice, otherwise goes straight to the report. */
  const endByCandidate = useCallback(async () => {
    setEndBusy(true);
    setEndError(null);
    const result = await endInterviewInOrder({
      closeVoice: closeForEnd,
      flushOutbox,
      requestEnd: () => endInterview(interviewId),
    });
    setEndBusy(false);
    if (!result.ok) {
      setEndError(endErrorMessage(result.code));
      return;
    }
    release();
    if (!result.body.report) {
      setEndedWithoutReport(true);
    } else if (onPausedScreen) {
      router.push(`/interviews/${interviewId}/report`);
    } else {
      end();
    }
  }, [closeForEnd, flushOutbox, interviewId, release, onPausedScreen, router, end]);
  const pausedEnd =
    pauseEnded || endedWithoutReport ? null : { busy: endBusy, error: endError, onEnd: () => void endByCandidate() };

  if (onPausedScreen && resumeBy) {
    if (!entered || recheckingDevices) {
      return (
        <InterviewLobby
          planning={planning}
          media={media}
          workspaceId={workspaceId}
          resume={{
            resumeBy,
            busy: pauseBusy || endBusy,
            error: pauseError,
            ended: pauseEnded || endedWithoutReport,
            endedWithoutReport,
            end: pausedEnd,
            workspaceId,
          }}
          onEnter={() => {
            if (!entered) {
              track("interview_started", { resumed: true });
            }
            void resume();
          }}
        />
      );
    }
    return (
      <InterviewPaused
        resumeBy={resumeBy}
        pausesLeft={pausesLeft}
        busy={pauseBusy || endBusy}
        error={pauseError}
        ended={pauseEnded || endedWithoutReport}
        endedWithoutReport={endedWithoutReport}
        endControl={pausedEnd}
        workspaceId={workspaceId}
        onResume={() => {
          setPauseError(null);
          setRecheckingDevices(true);
        }}
      />
    );
  }

  if (!entered) {
    return (
      <InterviewLobby
        planning={planning}
        media={media}
        workspaceId={workspaceId}
        onEnter={() => {
          track("interview_started", { resumed: false });
          setEntered(true);
          start();
        }}
      />
    );
  }
  const canStop =
    !over && !endBusy && voice.clock !== null && (status === "live" || status === "reconnecting" || status === "error");
  const canEnd = !over && voice.clock !== null;
  const termination = endedWithoutReport
    ? NO_REPORT_MESSAGE
    : terminated
      ? (integrity.termination ?? "The interview was ended after a third integrity warning.")
      : null;
  return (
    <InterviewRoom
      status={status}
      error={error}
      timeUp={timeUp}
      ended={ended}
      pauseReason={voice.pauseReason}
      resumed={voice.resumed}
      warning={integrity.warning}
      termination={termination}
      interviewId={interviewId}
      workspaceId={workspaceId}
      examining={voice.examining}
      clock={voice.clock}
      transcript={voice.transcript}
      syncError={voice.syncError}
      stop={canStop ? { pausesLeft, busy: pauseBusy, error: pauseError, onStop: () => void stopInterview() } : null}
      endControl={canEnd ? { busy: endBusy, error: endError, onEnd: () => void endByCandidate() } : null}
      onReconnect={voice.reconnect}
      onDismissWarning={integrity.dismissWarning}
    />
  );
}
