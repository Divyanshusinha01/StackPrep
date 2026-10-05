"use client";

import { useEffect, useRef, useState } from "react";
import { submitIntegrityFrame } from "@/lib/interview-events";
import { createIntegrityMonitor } from "./integrity-monitor";

/** Frames are downscaled to this width before encoding; the backend asks for low detail anyway. */
const FRAME_WIDTH = 320;
const JPEG_QUALITY = 0.7;

export interface IntegrityWarning {
  number: number;
  message: string;
}

/** Draws the live video track to an offscreen canvas. The encoded frame is the only copy kept, until it is sent. */
function createFrameGrabber() {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  const canvas = document.createElement("canvas");

  return {
    async grab(track: MediaStreamTrack): Promise<string | null> {
      if (track.readyState !== "live") {
        return null;
      }
      const current = video.srcObject instanceof MediaStream ? video.srcObject.getVideoTracks()[0] : null;
      if (current !== track) {
        video.srcObject = new MediaStream([track]);
        await video.play().catch(() => undefined);
      }
      if (!video.videoWidth || !video.videoHeight) {
        return null;
      }
      canvas.width = FRAME_WIDTH;
      canvas.height = Math.round((video.videoHeight * FRAME_WIDTH) / video.videoWidth);
      const context = canvas.getContext("2d");
      if (!context) {
        return null;
      }
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const image = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
      canvas.width = 0;
      canvas.height = 0;
      return image;
    },
    dispose() {
      video.srcObject = null;
    },
  };
}

/**
 * Integrity monitoring on the interview's shared camera track (PRD section 20). Runs only while
 * `enabled`; the caller enables it once the voice session is connected and acknowledged.
 */
export function useIntegrityMonitor({
  interviewId,
  stream,
  enabled,
  onTerminated,
}: {
  interviewId: string;
  stream: MediaStream | null;
  enabled: boolean;
  onTerminated: () => void;
}) {
  const [warning, setWarning] = useState<IntegrityWarning | null>(null);
  const [termination, setTermination] = useState<string | null>(null);
  const streamRef = useRef(stream);
  const enabledRef = useRef(enabled);
  const onTerminatedRef = useRef(onTerminated);
  const monitorRef = useRef<ReturnType<typeof createIntegrityMonitor> | null>(null);

  useEffect(() => {
    streamRef.current = stream;
    onTerminatedRef.current = onTerminated;
  }, [stream, onTerminated]);

  useEffect(() => {
    const grabber = createFrameGrabber();
    const monitor = createIntegrityMonitor({
      capture: () => {
        const track = streamRef.current?.getVideoTracks()[0];
        return track ? grabber.grab(track) : null;
      },
      submit: (image) => submitIntegrityFrame(interviewId, image),
      onResult: (body) => {
        if (body.status === "warning") {
          setWarning({ number: body.warning_number, message: body.message });
        } else if (body.status === "terminated") {
          setWarning(null);
          setTermination(body.message);
          onTerminatedRef.current();
        }
      },
    });
    monitorRef.current = monitor;
    monitor.setEnabled(enabledRef.current);
    return () => {
      monitor.dispose();
      grabber.dispose();
      monitorRef.current = null;
    };
  }, [interviewId]);

  useEffect(() => {
    enabledRef.current = enabled;
    monitorRef.current?.setEnabled(enabled);
  }, [enabled]);

  return { warning, termination, dismissWarning: () => setWarning(null) };
}
