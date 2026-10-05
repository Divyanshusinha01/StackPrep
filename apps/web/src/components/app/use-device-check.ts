"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type DeviceError = "denied" | "not_found" | "unsupported" | "failed";

/** RMS level that counts as hearing the user, roughly normal speech at arm's length. */
const MIC_THRESHOLD = 0.02;

function toDeviceError(err: unknown): DeviceError {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "denied";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "not_found";
  }
  return "failed";
}

/**
 * Camera preview plus microphone level. The camera passes once frames render; the microphone
 * passes once it picks up sound above the threshold. Tracks are stopped on unmount.
 */
export function useDeviceCheck() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const meterRef = useRef<HTMLDivElement>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const [phase, setPhase] = useState<"idle" | "requesting" | "active" | "error">("idle");
  const [error, setError] = useState<DeviceError | null>(null);
  const [cameraOk, setCameraOk] = useState(false);
  const [micOk, setMicOk] = useState(false);

  const stop = useCallback(() => {
    cleanupRef.current?.();
    cleanupRef.current = null;
  }, []);

  useEffect(() => stop, [stop]);

  const start = useCallback(async () => {
    stop();
    setError(null);
    setCameraOk(false);
    setMicOk(false);
    if (!navigator.mediaDevices?.getUserMedia) {
      setPhase("error");
      setError("unsupported");
      return;
    }

    setPhase("requesting");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch (err) {
      setPhase("error");
      setError(toDeviceError(err));
      return;
    }

    const audio = new AudioContext();
    const analyser = audio.createAnalyser();
    analyser.fftSize = 1024;
    audio.createMediaStreamSource(stream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    let frame = 0;
    const tick = () => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const s of samples) {
        sum += s * s;
      }
      const rms = Math.sqrt(sum / samples.length);
      if (meterRef.current) {
        meterRef.current.style.transform = `scaleX(${Math.min(1, rms * 10)})`;
      }
      if (rms > MIC_THRESHOLD) {
        setMicOk(true);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    const onEnded = () => {
      setPhase("error");
      setError("failed");
      setCameraOk(false);
      setMicOk(false);
    };
    for (const track of stream.getTracks()) {
      track.addEventListener("ended", onEnded);
    }
    const video = videoRef.current;
    if (video) {
      video.srcObject = stream;
    }

    cleanupRef.current = () => {
      cancelAnimationFrame(frame);
      for (const track of stream.getTracks()) {
        track.removeEventListener("ended", onEnded);
        track.stop();
      }
      void audio.close();
      if (video) {
        video.srcObject = null;
      }
    };
    setPhase("active");
  }, [stop]);

  const onVideoLoaded = useCallback(() => {
    setCameraOk((videoRef.current?.videoWidth ?? 0) > 0);
  }, []);

  return { videoRef, meterRef, phase, error, cameraOk, micOk, start, onVideoLoaded };
}
