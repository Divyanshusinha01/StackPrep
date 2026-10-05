"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createMediaOwner, type MediaError, type MediaOwner, toMediaError } from "./interview-media";

export type MediaPhase = "idle" | "requesting" | "active" | "error";

export interface InterviewMedia {
  stream: MediaStream | null;
  phase: MediaPhase;
  error: MediaError | null;
  /** Returns a stream with every track live, re-acquiring if a device failed. Rejects if the devices cannot be opened. */
  acquire(): Promise<MediaStream>;
  release(): void;
}

/** Owned by InterviewSession, so the stream survives the lobby-to-room switch and reconnects. */
export function useInterviewMedia(): InterviewMedia {
  const ownerRef = useRef<MediaOwner | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [phase, setPhase] = useState<MediaPhase>("idle");
  const [error, setError] = useState<MediaError | null>(null);

  const owner = useCallback(() => {
    ownerRef.current ??= createMediaOwner(
      typeof navigator !== "undefined" && navigator.mediaDevices?.getUserMedia
        ? (constraints) => navigator.mediaDevices.getUserMedia(constraints)
        : null,
    );
    return ownerRef.current;
  }, []);

  const acquire = useCallback(async () => {
    const media = owner();
    const existing = media.current();
    if (!existing || existing.getTracks().some((t) => t.readyState !== "live")) {
      setPhase("requesting");
    }
    try {
      const next = await media.acquire();
      setStream(next);
      setError(null);
      setPhase("active");
      return next;
    } catch (err) {
      setStream(null);
      setError(toMediaError(err));
      setPhase("error");
      throw err;
    }
  }, [owner]);

  const release = useCallback(() => {
    ownerRef.current?.release();
    setStream(null);
    setPhase("idle");
  }, []);

  useEffect(() => () => ownerRef.current?.release(), []);

  return { stream, phase, error, acquire, release };
}
