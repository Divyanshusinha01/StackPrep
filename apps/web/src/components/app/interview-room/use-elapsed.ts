"use client";

import { useEffect, useState } from "react";
import type { VoiceClock } from "@/components/app/use-realtime-interview";

export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** Elapsed voice time; ticks only while connected, matching how the backend counts it. */
export function useElapsed(clock: VoiceClock | null, live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) {
      return;
    }
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [live]);
  if (!clock) {
    return 0;
  }
  return clock.usedSeconds + Math.max(0, (now - clock.connectedAt) / 1000);
}

/** True for a few seconds after `on` turns on. */
export function useBriefly(on: boolean, ms: number): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!on) {
      return;
    }
    const show = window.setTimeout(() => setVisible(true), 0);
    const hide = window.setTimeout(() => setVisible(false), ms);
    return () => {
      window.clearTimeout(show);
      window.clearTimeout(hide);
      setVisible(false);
    };
  }, [on, ms]);
  return on && visible;
}
