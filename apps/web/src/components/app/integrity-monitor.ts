import { INTEGRITY_FRAME_INTERVAL_MS, type IntegrityFrameResponse } from "@stackprep/shared";

/**
 * Sends one camera frame about every 10 seconds while enabled. The next frame is scheduled only
 * after the previous request settles, so requests never overlap and arrive at least an interval
 * apart. While disabled (the voice session is interrupted or reconnecting) nothing is captured or
 * submitted; a request already in flight still reports its outcome.
 */

export type FrameSubmitResult =
  | { ok: true; body: IntegrityFrameResponse }
  | { ok: false; code: string };

export interface IntegrityMonitorOptions {
  /** A JPEG data URL of the current camera frame, or null if no frame is available. */
  capture(): Promise<string | null> | string | null;
  submit(image: string): Promise<FrameSubmitResult>;
  onResult(body: IntegrityFrameResponse): void;
  intervalMs?: number;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

export interface IntegrityMonitor {
  setEnabled(enabled: boolean): void;
  dispose(): void;
}

export function createIntegrityMonitor({
  capture,
  submit,
  onResult,
  intervalMs = INTEGRITY_FRAME_INTERVAL_MS,
  setTimer = (run, ms) => setTimeout(run, ms),
  clearTimer = (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
}: IntegrityMonitorOptions): IntegrityMonitor {
  let enabled = false;
  let stopped = false;
  let timer: unknown = null;
  let inFlight = false;

  const schedule = () => {
    if (enabled && !stopped && !inFlight && timer === null) {
      timer = setTimer(tick, intervalMs);
    }
  };

  async function tick() {
    timer = null;
    if (!enabled || stopped) {
      return;
    }
    inFlight = true;
    try {
      const image = await capture();
      if (!image || !enabled || stopped) {
        return;
      }
      const result = await submit(image);
      if (stopped) {
        return;
      }
      if (result.ok) {
        if (result.body.status === "terminated") {
          stopped = true;
        }
        onResult(result.body);
      }
    } catch {
      // A failed capture or request is skipped; the next interval tries again.
    } finally {
      inFlight = false;
      schedule();
    }
  }

  return {
    setEnabled(next) {
      enabled = next;
      if (!next && timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      schedule();
    },
    dispose() {
      stopped = true;
      enabled = false;
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
    },
  };
}
