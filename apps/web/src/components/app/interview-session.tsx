"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { InterviewPlanning } from "@stackprep/shared";
import { InterviewLobby } from "@/components/app/interview-lobby";
import { InterviewRoom } from "@/components/app/interview-room";
import { useIntegrityMonitor } from "@/components/app/use-integrity-monitor";
import { useInterviewMedia } from "@/components/app/use-interview-media";
import { useRealtimeInterview } from "@/components/app/use-realtime-interview";

const PREPARING_RETRY_MS = 4000;
/** Leaves the closing notice on screen briefly before moving to the report. */
const REPORT_REDIRECT_MS = 3000;

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
  const { status, error, ended, timeUp, terminated, start, terminate } = voice;
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
