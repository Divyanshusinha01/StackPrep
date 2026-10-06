"use client";

import { useEffect, useRef, useState } from "react";
import type { InterviewStreamEvent } from "@stackprep/shared";
import { env } from "@/env";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { startInterviewEventStream } from "./interview-event-stream";
import { usePollWhile } from "./use-poll-while";

export type InterviewEventsMode = "idle" | "stream" | "polling";

/**
 * Server-to-client interview events over SSE while `enabled`. After repeated failed connects the
 * stream is abandoned for the rest of the session and the page is re-rendered by polling instead,
 * which picks up the same persisted state (the server page redirects once the interview ends).
 */
export function useInterviewEvents(
  interviewId: string,
  { enabled, onEvent }: { enabled: boolean; onEvent: (event: InterviewStreamEvent) => void },
): InterviewEventsMode {
  const [fallback, setFallback] = useState(false);
  const onEventRef = useRef(onEvent);
  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    if (!enabled || fallback) {
      return;
    }
    const supabase = createSupabaseBrowserClient();
    const stream = startInterviewEventStream({
      url: `${env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/interviews/${encodeURIComponent(interviewId)}/events`,
      getHeaders: async () => {
        const { data } = await supabase.auth.getSession();
        const token = data.session?.access_token;
        return token ? { Authorization: `Bearer ${token}`, apikey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY } : null;
      },
      onEvent: (event) => onEventRef.current(event),
      onFallback: () => setFallback(true),
    });
    return () => stream.stop();
  }, [enabled, fallback, interviewId]);

  usePollWhile(enabled && fallback);
  return !enabled ? "idle" : fallback ? "polling" : "stream";
}
