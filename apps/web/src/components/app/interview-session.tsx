"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { InterviewPlanning, InterviewStreamEvent } from "@stackprep/shared";
import { InterviewLobby } from "@/components/app/interview-lobby";
import { InterviewRoom } from "@/components/app/interview-room";
import { useIntegrityMonitor } from "@/components/app/use-integrity-monitor";
import { useInterviewEvents } from "@/components/app/use-interview-events";
import { useInterviewMedia } from "@/components/app/use-interview-media";
import { useRealtimeInterview } from "@/components/app/use-realtime-interview";

const PREPARING_RETRY_MS = 4000;
/** Leaves the closing notice on screen briefly before moving to the report. */
const REPORT_REDIRECT_MS = 3000;
/** A streamed completion waits this long for a live session's closing turn before ending the room. */
const STREAMED_COMPLETION_GRACE_MS = 30_000;

/**
 * Lobby until the candidate enters, then the live room; the report once the interview ends.
 * Owns the interview's single camera + microphone stream, shared by the lobby check, the voice
 * session, and integrity monitoring.
 */
export function InterviewSession({
  interviewId,
  workspaceId,
  planning,
}: {
  interviewId: string;
  workspaceId: string;
  planning: InterviewPlanning | null;
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
      onReconnect={voice.reconnect}
      onDismissWarning={integrity.dismissWarning}
    />
  );
}
