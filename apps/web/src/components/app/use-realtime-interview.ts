"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  type ApiErrorCode,
  apiErrorSchema,
  type PauseReason,
  realtimeSessionResponseSchema,
  VOICE_LIMIT_SECONDS,
} from "@stackprep/shared";
import { FunctionsHttpError } from "@supabase/supabase-js";
import { sendEvent, sendToolCall } from "@/lib/interview-events";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { examiningReducer } from "./examining";
import { toMediaError } from "./interview-media";
import { relayToolCall } from "./realtime-tool-relay";
import { EMPTY_TRANSCRIPT, type RealtimeServerEvent, transcriptReducer } from "./realtime-transcript";
import {
  backoffDelay,
  hasConnection,
  INITIAL_RECONNECT_STATE,
  integrityFramesReady,
  type InterruptionCause,
  MUTE_GRACE_MS,
  type ReconnectPhase,
  reconnectReducer,
} from "./reconnect-machine";
import {
  browserWakeSignals,
  createTranscriptOutbox,
  drainTurns,
  newlyFinalTurns,
  type OutboxStorage,
  outboxStorageKey,
  type TranscriptOutbox,
} from "./transcript-outbox";
import type { InterviewMedia } from "./use-interview-media";

const REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls";
/** Upper bound on the interviewer's closing turn once the backend has ended the interview. */
const CLOSING_GRACE_MS = 30_000;

export type RealtimeStatus = "idle" | "connecting" | "live" | "reconnecting" | "error" | "closed";

export type RealtimeErrorCode =
  | ApiErrorCode
  | "microphone_denied"
  | "microphone_unavailable"
  | "connection_failed"
  | "connection_lost";

/** Failures a reconnect cannot fix; the coordinator stops retrying on these. */
export const NOT_RETRYABLE: ReadonlySet<RealtimeErrorCode> = new Set([
  "interview_planning_failed",
  "interview_not_active",
  "interview_not_found",
  "unauthorized",
  "interview_preparing",
  "microphone_denied",
]);

export interface VoiceClock {
  /** Voice time already used before this connection. */
  usedSeconds: number;
  /** When this connection went live (ms since epoch). */
  connectedAt: number;
}

class RealtimeStartError extends Error {
  constructor(readonly code: RealtimeErrorCode) {
    super(code);
  }
}

function mediaErrorCode(err: unknown): RealtimeErrorCode {
  return toMediaError(err) === "denied" ? "microphone_denied" : "microphone_unavailable";
}

async function requestSession(interviewId: string) {
  const supabase = createSupabaseBrowserClient();
  const { data, error } = await supabase.functions.invoke(
    `interviews/${encodeURIComponent(interviewId)}/realtime/session`,
    { method: "POST" },
  );
  if (!error) {
    const parsed = realtimeSessionResponseSchema.safeParse(data);
    if (!parsed.success) {
      throw new RealtimeStartError("realtime_unavailable");
    }
    return parsed.data;
  }
  if (error instanceof FunctionsHttpError) {
    const body = await (error.context as Response).json().catch(() => null);
    const parsed = apiErrorSchema.safeParse(body);
    if (parsed.success) {
      throw new RealtimeStartError(parsed.data.code);
    }
  }
  throw new RealtimeStartError("realtime_unavailable");
}

function localStorageOrNull(): OutboxStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function toStatus(phase: ReconnectPhase): RealtimeStatus {
  switch (phase) {
    case "idle":
      return "idle";
    case "connecting":
      return "connecting";
    case "connected":
    case "suspect":
      return "live";
    case "interrupted":
    case "reconnecting":
      return "reconnecting";
    case "exhausted":
    case "failed":
      return "error";
    case "closed":
      return "closed";
  }
}

/**
 * Live voice session: the backend mints a short-lived credential, then the browser opens a
 * WebRTC call straight to OpenAI with the interview's shared microphone track. Finalized
 * transcript turns and voice events go through a persistent outbox, so unsent ones survive a
 * refresh and are retried until acked. Drops are recovered by the reconnect coordinator, which
 * flushes saved answers before each new session so the backend can resume from them.
 */
export function useRealtimeInterview(interviewId: string, media: InterviewMedia) {
  const [machine, dispatchMachine] = useReducer(reconnectReducer, INITIAL_RECONNECT_STATE);
  const [timeUp, setTimeUp] = useState(false);
  /** The backend ended the interview (end_interview accepted, or the voice cap was reached). */
  const [ended, setEnded] = useState(false);
  const [examining, dispatchExamining] = useReducer(examiningReducer, null);
  const [clock, setClock] = useState<VoiceClock | null>(null);
  /** Code of the last event the backend refused; that event was dropped. */
  const [syncError, setSyncError] = useState<string | null>(null);
  /** Attempt whose `connected` (first connection) or `resume` (reconnect) event the backend stored. */
  const [ackedAttempt, setAckedAttempt] = useState<number | null>(null);
  const [transcript, dispatch] = useReducer(transcriptReducer, EMPTY_TRANSCRIPT);
  const cleanupRef = useRef<(() => void) | null>(null);
  /** The coordinator's current attempt id; a superseded attempt cannot touch state. */
  const attemptRef = useRef(0);
  const startedAttemptRef = useRef(0);
  const reportedInterruptionsRef = useRef(0);
  const gateRef = useRef<{ attempt: number; clientEventId: string } | null>(null);
  const highestAckedTurnRef = useRef(0);
  const outboxRef = useRef<TranscriptOutbox | null>(null);
  const seenTurnsRef = useRef(new Set<string>());
  const { acquire } = media;

  const teardown = useCallback(() => {
    cleanupRef.current?.();
    cleanupRef.current = null;
  }, []);

  useEffect(() => {
    attemptRef.current = machine.attempt;
  }, [machine.attempt]);

  useEffect(
    () => () => {
      attemptRef.current = -1;
      teardown();
    },
    [teardown],
  );

  // Declared after the teardown effect so, on unmount, the final `disconnected` is enqueued
  // before this outbox is flushed and disposed.
  useEffect(() => {
    const outbox = createTranscriptOutbox({
      storageKey: outboxStorageKey(interviewId),
      storage: localStorageOrNull(),
      send: (event) => sendEvent(interviewId, event),
      subscribeWake: browserWakeSignals,
      onDrop: (item, code) => {
        console.warn(`Dropped interview ${item.type} event: ${code}`);
        setSyncError(code);
      },
      onAck: (item, ack) => {
        if (ack.type === "transcript_turn") {
          highestAckedTurnRef.current = Math.max(highestAckedTurnRef.current, ack.turn_sequence);
        }
        const gate = gateRef.current;
        if (gate && gate.clientEventId === item.client_event_id) {
          setAckedAttempt(gate.attempt);
        }
      },
    });
    outboxRef.current = outbox;
    return () => {
      void outbox.flush();
      outbox.dispose();
      outboxRef.current = null;
    };
  }, [interviewId]);

  useEffect(() => {
    const outbox = outboxRef.current;
    if (!outbox) {
      return;
    }
    for (const turn of newlyFinalTurns(transcript, seenTurnsRef.current)) {
      outbox.enqueue(turn);
    }
  }, [transcript]);

  useEffect(() => {
    if (!examining) {
      return;
    }
    const id = window.setTimeout(
      () => dispatchExamining({ type: "expire", at: Date.now() }),
      Math.max(0, examining.until - Date.now()),
    );
    return () => window.clearTimeout(id);
  }, [examining]);

  const connect = useCallback(async (attempt: number, resuming: boolean) => {
    const current = () => attempt === attemptRef.current;
    teardown();
    dispatchExamining({ type: "reset" });

    let pc: RTCPeerConnection | null = null;
    let audio: HTMLAudioElement | null = null;
    let hardStop = 0;
    let closingTimer = 0;
    /** After the backend ends the interview: wait for the closing response, then for its audio to finish. */
    let closing: "none" | "awaiting_response" | "speaking" = "none";
    let connected = false;
    const detach: (() => void)[] = [];
    const cleanup = () => {
      window.clearTimeout(hardStop);
      window.clearTimeout(closingTimer);
      detach.splice(0).forEach((off) => off());
      if (connected) {
        connected = false;
        outboxRef.current?.enqueue({ type: "disconnected" });
        void outboxRef.current?.flush();
      }
      if (pc) {
        pc.onconnectionstatechange = null;
        pc.close();
      }
      if (audio) {
        audio.srcObject = null;
      }
    };
    cleanupRef.current = cleanup;

    const signal = (cause: InterruptionCause, reason: PauseReason) =>
      dispatchMachine({ type: "signal", attempt, cause, reason });

    try {
      if (typeof RTCPeerConnection === "undefined") {
        throw new RealtimeStartError("microphone_unavailable");
      }
      let stream: MediaStream;
      try {
        stream = await acquire();
      } catch (err) {
        throw new RealtimeStartError(mediaErrorCode(err));
      }
      if (!current()) {
        cleanup();
        return;
      }

      // Saved answers first, so the backend's recap is built from them.
      const outbox = outboxRef.current;
      if (outbox) {
        await drainTurns(outbox);
      }
      if (!current()) {
        cleanup();
        return;
      }
      let session = await requestSession(interviewId);
      if (!current()) {
        cleanup();
        return;
      }
      if (outbox && session.resume && highestAckedTurnRef.current > session.resume.last_turn_sequence) {
        // A turn was stored after the recap was read: rebuild the session so it is not lost.
        await drainTurns(outbox);
        if (!current()) {
          cleanup();
          return;
        }
        session = await requestSession(interviewId);
        if (!current()) {
          cleanup();
          return;
        }
      }

      for (const track of stream.getTracks()) {
        const reason: PauseReason = track.kind === "video" ? "camera" : "microphone";
        const onEnded = () => signal("track_ended", reason);
        const onMute = () => dispatchMachine({ type: "track_muted", attempt, reason });
        const onUnmute = () => dispatchMachine({ type: "track_unmuted", attempt });
        track.addEventListener("ended", onEnded);
        track.addEventListener("mute", onMute);
        track.addEventListener("unmute", onUnmute);
        detach.push(() => {
          track.removeEventListener("ended", onEnded);
          track.removeEventListener("mute", onMute);
          track.removeEventListener("unmute", onUnmute);
        });
      }

      pc = new RTCPeerConnection();
      audio = new Audio();
      audio.autoplay = true;
      const audioEl = audio;
      pc.ontrack = (e) => {
        audioEl.srcObject = e.streams[0] ?? null;
      };
      for (const track of stream.getAudioTracks()) {
        pc.addTrack(track, stream);
      }

      const finish = () => {
        if (current()) {
          setEnded(true);
          dispatchMachine({ type: "close", reason: "ended" });
        }
      };
      const channel = pc.createDataChannel("oai-events");
      channel.onmessage = (e) => {
        let event: RealtimeServerEvent;
        try {
          event = JSON.parse(String(e.data)) as RealtimeServerEvent;
        } catch {
          return;
        }
        if (typeof event?.type !== "string") {
          return;
        }
        dispatch(event);
        if (closing === "awaiting_response" && event.type === "response.created") {
          closing = "speaking";
        } else if (closing === "speaking" && event.type === "output_audio_buffer.stopped") {
          finish();
          return;
        }
        void relayToolCall(event, (call) => sendToolCall(interviewId, call)).then((relay) => {
          if (!relay || !current()) {
            return;
          }
          if (relay.examined.length > 0) {
            dispatchExamining({ type: "examined", items: relay.examined, at: Date.now() });
          }
          // Set before the output is sent, so the closing response's events are recognized.
          if (relay.ending && closing === "none") {
            closing = "awaiting_response";
            closingTimer = window.setTimeout(finish, CLOSING_GRACE_MS);
          }
          if (channel.readyState === "open") {
            for (const reply of relay.events) {
              channel.send(JSON.stringify(reply));
            }
          }
        });
      };
      channel.onopen = () => {
        if (!current()) {
          return;
        }
        connected = true;
        const opened = outboxRef.current?.enqueue({ type: "connected" });
        const gate = resuming ? outboxRef.current?.enqueue({ type: "resume" }) : opened;
        gateRef.current = gate ? { attempt, clientEventId: gate.client_event_id } : null;
        const usedSeconds = VOICE_LIMIT_SECONDS - session.remaining_voice_seconds;
        setClock({ usedSeconds, connectedAt: Date.now() });
        dispatchMachine({ type: "connected", attempt });
        hardStop = window.setTimeout(() => {
          if (current()) {
            setTimeUp(true);
            dispatchMachine({ type: "close", reason: "time_up" });
          }
        }, session.remaining_voice_seconds * 1000);
      };
      channel.onclose = () => signal("channel_closed", "connection");
      const connection = pc;
      connection.onconnectionstatechange = () => {
        if (connection.connectionState === "failed") {
          signal("connection_failed", "network");
        }
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      let res: Response;
      try {
        res = await fetch(REALTIME_CALLS_URL, {
          method: "POST",
          body: offer.sdp,
          headers: { Authorization: `Bearer ${session.client_secret}`, "Content-Type": "application/sdp" },
        });
      } catch {
        throw new RealtimeStartError("connection_failed");
      }
      if (!res.ok) {
        throw new RealtimeStartError("connection_failed");
      }
      const sdp = await res.text();
      if (!current()) {
        cleanup();
        return;
      }
      await pc.setRemoteDescription({ type: "answer", sdp });
    } catch (err) {
      if (!current()) {
        cleanup();
        return;
      }
      const code = err instanceof RealtimeStartError ? err.code : "connection_failed";
      dispatchMachine({ type: "attempt_failed", attempt, code, retryable: !NOT_RETRYABLE.has(code) });
    }
  }, [acquire, interviewId, teardown]);

  // Only the coordinator starts attempts: one connect per attempt id.
  useEffect(() => {
    const { phase, attempt } = machine;
    if ((phase === "connecting" || phase === "reconnecting") && startedAttemptRef.current !== attempt) {
      startedAttemptRef.current = attempt;
      void connect(attempt, phase === "reconnecting");
    }
  }, [machine, connect]);

  useEffect(() => {
    if (!hasConnection(machine.phase)) {
      teardown();
    }
  }, [machine.phase, teardown]);

  // One `pause` per interruption, after the `disconnected` the teardown enqueues.
  useEffect(() => {
    if (machine.interruptions <= reportedInterruptionsRef.current) {
      return;
    }
    reportedInterruptionsRef.current = machine.interruptions;
    teardown();
    outboxRef.current?.enqueue({ type: "pause", reason: machine.reason ?? "connection" });
  }, [machine.interruptions, machine.reason, teardown]);

  useEffect(() => {
    if (machine.phase !== "interrupted") {
      return;
    }
    const id = window.setTimeout(() => dispatchMachine({ type: "retry" }), backoffDelay(machine.retries));
    return () => window.clearTimeout(id);
  }, [machine.phase, machine.retries]);

  useEffect(() => {
    if (machine.phase !== "suspect") {
      return;
    }
    const attempt = machine.attempt;
    const id = window.setTimeout(() => dispatchMachine({ type: "grace_expired", attempt }), MUTE_GRACE_MS);
    return () => window.clearTimeout(id);
  }, [machine.phase, machine.attempt]);

  useEffect(() => {
    const onOffline = () =>
      dispatchMachine({ type: "signal", attempt: attemptRef.current, cause: "offline", reason: "network" });
    const onOnline = () => dispatchMachine({ type: "online" });
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    return () => {
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
    };
  }, []);

  const start = useCallback(() => {
    setTimeUp(false);
    setEnded(false);
    dispatchMachine({ type: "start" });
  }, []);
  const reconnect = useCallback(() => dispatchMachine({ type: "manual_retry" }), []);
  const stop = useCallback(() => dispatchMachine({ type: "close", reason: "stopped" }), []);
  /** The backend terminated the interview (third integrity warning). */
  const terminate = useCallback(() => dispatchMachine({ type: "close", reason: "terminated" }), []);

  const status = toStatus(machine.phase);
  const error = (machine.phase === "exhausted" ? "connection_lost" : machine.phase === "failed" ? machine.error : null) as
    | RealtimeErrorCode
    | null;

  return {
    status,
    phase: machine.phase,
    error,
    timeUp,
    ended,
    terminated: machine.closeReason === "terminated",
    /** Why the voice session is paused while reconnecting. */
    pauseReason: status === "reconnecting" ? machine.reason : null,
    /** True once a reconnect succeeded, until the next interruption. */
    resumed: machine.resumed,
    /** Integrity frames are allowed: connected, and the backend has stored the connect or resume event. */
    integrityReady: integrityFramesReady(machine, ackedAttempt),
    examining: examining?.items ?? null,
    clock,
    transcript,
    syncError,
    start,
    reconnect,
    stop,
    terminate,
  };
}
