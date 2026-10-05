"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { InterviewPlanning } from "@stackprep/shared";
import { InterviewLobby } from "@/components/app/interview-lobby";
import { InterviewRoom } from "@/components/app/interview-room";
import { useRealtimeInterview } from "@/components/app/use-realtime-interview";

const PREPARING_RETRY_MS = 4000;
/** Leaves the closing notice on screen briefly before moving to the report. */
const REPORT_REDIRECT_MS = 3000;

/** Lobby until the candidate enters, then the live room; the report once the interview ends. */
export function InterviewSession({ interviewId, planning }: { interviewId: string; planning: InterviewPlanning | null }) {
  const router = useRouter();
  const [entered, setEntered] = useState(false);
  const { status, error, timeUp, ended, examining, clock, transcript, start } = useRealtimeInterview(interviewId);

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
    const id = window.setTimeout(() => void start(), PREPARING_RETRY_MS);
    return () => window.clearTimeout(id);
  }, [preparing, start]);

  if (!entered) {
    return (
      <InterviewLobby
        planning={planning}
        onEnter={() => {
          setEntered(true);
          void start();
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
      examining={examining}
      clock={clock}
      transcript={transcript}
      onReconnect={() => void start()}
    />
  );
}
