"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MediaError } from "./interview-media";
import type { InterviewMedia } from "./use-interview-media";

export type DeviceError = MediaError;

/** RMS level that counts as hearing the user, roughly normal speech at arm's length. */
const MIC_THRESHOLD = 0.02;

/**
 * Camera preview plus microphone level on the interview's shared stream. The camera passes once
 * frames render; the microphone passes once it picks up sound above the threshold. Tracks are
 * never stopped here: the same stream continues into the interview.
 */
export function useDeviceCheck(media: InterviewMedia) {
  const { stream, acquire } = media;
  const videoRef = useRef<HTMLVideoElement>(null);
  const meterRef = useRef<HTMLDivElement>(null);
  const [endedError, setEndedError] = useState(false);
  const [cameraOk, setCameraOk] = useState(false);
  const [micOk, setMicOk] = useState(false);

  useEffect(() => {
    if (!stream) {
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
      setEndedError(true);
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

    return () => {
      cancelAnimationFrame(frame);
      for (const track of stream.getTracks()) {
        track.removeEventListener("ended", onEnded);
      }
      void audio.close();
      if (video) {
        video.srcObject = null;
      }
    };
  }, [stream]);

  const start = useCallback(async () => {
    setEndedError(false);
    setCameraOk(false);
    setMicOk(false);
    try {
      await acquire();
    } catch {
      // Surfaced through media.error.
    }
  }, [acquire]);

  const onVideoLoaded = useCallback(() => {
    setCameraOk((videoRef.current?.videoWidth ?? 0) > 0);
  }, []);

  const error: DeviceError | null = endedError ? "failed" : media.error;
  const phase = endedError ? "error" : media.phase;
  return { videoRef, meterRef, phase, error, cameraOk, micOk, start, onVideoLoaded };
}
