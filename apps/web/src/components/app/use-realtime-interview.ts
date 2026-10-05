"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { type ApiErrorCode, apiErrorSchema, realtimeSessionResponseSchema, VOICE_LIMIT_SECONDS } from "@stackprep/shared";
import { FunctionsHttpError } from "@supabase/supabase-js";
import { sendEvent } from "@/lib/interview-events";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { relayToolCall } from "./realtime-tool-relay";
import { EMPTY_TRANSCRIPT, type RealtimeServerEvent, transcriptReducer } from "./realtime-transcript";
import {
  browserWakeSignals,
  createTranscriptOutbox,
  newlyFinalTurns,
  type OutboxStorage,
  outboxStorageKey,
  type TranscriptOutbox,
} from "./transcript-outbox";

const REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls";

export type RealtimeStatus = "idle" | "connecting" | "live" | "error" | "closed";

export type RealtimeErrorCode =
  | ApiErrorCode
  | "microphone_denied"
  | "microphone_unavailable"
  | "connection_failed"
  | "connection_lost";

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

function microphoneError(err: unknown): RealtimeErrorCode {
  const name = err instanceof DOMException ? err.name : "";
  return name === "NotAllowedError" || name === "SecurityError" ? "microphone_denied" : "microphone_unavailable";
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

/**
 * Live voice session: the backend mints a short-lived credential, then the browser opens a
 * WebRTC call straight to OpenAI. Finalized transcript turns and connected/disconnected events
 * go through a persistent outbox, so unsent ones survive a refresh and are retried until acked.
 */
export function useRealtimeInterview(interviewId: string) {
  const [status, setStatus] = useState<RealtimeStatus>("idle");
  const [error, setError] = useState<RealtimeErrorCode | null>(null);
  const [timeUp, setTimeUp] = useState(false);
  const [clock, setClock] = useState<VoiceClock | null>(null);
  /** Code of the last event the backend refused; that event was dropped. */
  const [syncError, setSyncError] = useState<string | null>(null);
  const [transcript, dispatch] = useReducer(transcriptReducer, EMPTY_TRANSCRIPT);
  const cleanupRef = useRef<(() => void) | null>(null);
  /** Bumped on every start/stop so a superseded start cannot touch state. */
  const attemptRef = useRef(0);
  const outboxRef = useRef<TranscriptOutbox | null>(null);
  const seenTurnsRef = useRef(new Set<string>());

  const teardown = useCallback(() => {
    cleanupRef.current?.();
    cleanupRef.current = null;
  }, []);

  const stop = useCallback(() => {
    attemptRef.current++;
    teardown();
    setStatus((s) => (s === "idle" ? s : "closed"));
  }, [teardown]);

  useEffect(
    () => () => {
      attemptRef.current++;
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

  const start = useCallback(async () => {
    attemptRef.current++;
    const attempt = attemptRef.current;
    const current = () => attempt === attemptRef.current;
    teardown();
    setError(null);
    setTimeUp(false);
    setStatus("connecting");

    let mic: MediaStream | null = null;
    let pc: RTCPeerConnection | null = null;
    let audio: HTMLAudioElement | null = null;
    let hardStop = 0;
    let connected = false;
    const cleanup = () => {
      window.clearTimeout(hardStop);
      if (connected) {
        connected = false;
        outboxRef.current?.enqueue({ type: "disconnected" });
        void outboxRef.current?.flush();
      }
      pc?.close();
      mic?.getTracks().forEach((t) => t.stop());
      if (audio) {
        audio.srcObject = null;
      }
    };
    cleanupRef.current = cleanup;

    const fail = (code: RealtimeErrorCode) => {
      if (!current()) {
        return;
      }
      attemptRef.current++;
      teardown();
      setError(code);
      setStatus("error");
    };

    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === "undefined") {
        throw new RealtimeStartError("microphone_unavailable");
      }
      try {
        mic = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      } catch (err) {
        throw new RealtimeStartError(microphoneError(err));
      }
      if (!current()) {
        cleanup();
        return;
      }

      const session = await requestSession(interviewId);
      if (!current()) {
        cleanup();
        return;
      }

      pc = new RTCPeerConnection();
      audio = new Audio();
      audio.autoplay = true;
      const audioEl = audio;
      pc.ontrack = (e) => {
        audioEl.srcObject = e.streams[0] ?? null;
      };
      for (const track of mic.getAudioTracks()) {
        pc.addTrack(track, mic);
      }

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
        for (const reply of relayToolCall(event)) {
          channel.send(JSON.stringify(reply));
        }
        dispatch(event);
      };
      channel.onopen = () => {
        if (!current()) {
          return;
        }
        connected = true;
        outboxRef.current?.enqueue({ type: "connected" });
        const usedSeconds = VOICE_LIMIT_SECONDS - session.remaining_voice_seconds;
        setClock({ usedSeconds, connectedAt: Date.now() });
        setStatus("live");
        hardStop = window.setTimeout(() => {
          if (current()) {
            setTimeUp(true);
            stop();
          }
        }, session.remaining_voice_seconds * 1000);
      };
      channel.onclose = () => fail("connection_lost");
      const connection = pc;
      connection.onconnectionstatechange = () => {
        if (connection.connectionState === "failed") {
          fail("connection_lost");
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
      fail(err instanceof RealtimeStartError ? err.code : "connection_failed");
    }
  }, [interviewId, stop, teardown]);

  return { status, error, timeUp, clock, transcript, syncError, start, stop };
}
