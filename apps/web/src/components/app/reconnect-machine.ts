import type { PauseReason } from "@stackprep/shared";

/**
 * Connection coordinator for the live voice session. Listeners (track ended or muted, offline,
 * peer connection failed, data channel closed) only dispatch signals; only this reducer decides
 * when a connection attempt starts. Every attempt has an id, so signals and completions from a
 * superseded attempt are ignored, and a storm of signals for one drop leads to one reconnect.
 *
 *   idle -> connecting -> connected -> (suspect ->) interrupted -> reconnecting -> connected
 *   reconnecting -> interrupted (retries left) | exhausted (manual Reconnect) | failed (not retryable)
 *   connected | suspect -> exhausted (idle timeout: no candidate speech; manual Reconnect, no auto retry)
 *   any live phase -> closed (ended, time up, integrity termination, candidate pause, unmount)
 *   closed (candidate pause) -> reconnecting (resume)
 */

export type ReconnectPhase =
  | "idle"
  | "connecting"
  | "connected"
  | "suspect"
  | "interrupted"
  | "reconnecting"
  | "exhausted"
  | "failed"
  | "closed";

export type InterruptionCause = "track_ended" | "offline" | "connection_failed" | "channel_closed";

export type CloseReason = "ended" | "time_up" | "terminated" | "stopped" | "paused";

export interface ReconnectState {
  phase: ReconnectPhase;
  /** Id of the current connection attempt; bumped whenever a new attempt starts. */
  attempt: number;
  /** Failed reconnect attempts since the last successful connection. */
  retries: number;
  /** Bumped each time a live connection is interrupted, so the pause is reported once. */
  interruptions: number;
  reason: PauseReason | null;
  /** Code of the failure that ended in `failed` or `exhausted`. */
  error: string | null;
  everConnected: boolean;
  /** The current connection is a resume after an interruption. */
  resumed: boolean;
  closeReason: CloseReason | null;
}

export type ReconnectEvent =
  | { type: "start" }
  | { type: "connected"; attempt: number }
  | { type: "attempt_failed"; attempt: number; code: string; retryable: boolean }
  | { type: "signal"; attempt: number; cause: InterruptionCause; reason: PauseReason }
  | { type: "track_muted"; attempt: number; reason: PauseReason }
  | { type: "track_unmuted"; attempt: number }
  | { type: "grace_expired"; attempt: number }
  | { type: "idle_timeout"; attempt: number }
  | { type: "retry" }
  | { type: "online" }
  | { type: "manual_retry" }
  | { type: "resume" }
  | { type: "close"; reason: CloseReason };

/** Waits before reconnect attempts 1-4; after the 4th failure the user reconnects manually. */
export const RECONNECT_BACKOFF_MS = [2_000, 4_000, 8_000, 16_000] as const;
/** How long a muted track may stay muted before it counts as an interruption. */
export const MUTE_GRACE_MS = 5_000;

export const INITIAL_RECONNECT_STATE: ReconnectState = {
  phase: "idle",
  attempt: 0,
  retries: 0,
  interruptions: 0,
  reason: null,
  error: null,
  everConnected: false,
  resumed: false,
  closeReason: null,
};

export function backoffDelay(retries: number): number {
  return RECONNECT_BACKOFF_MS[Math.min(retries, RECONNECT_BACKOFF_MS.length - 1)];
}

const LIVE: ReadonlySet<ReconnectPhase> = new Set(["connecting", "connected", "suspect", "interrupted", "reconnecting"]);
const ATTEMPTING: ReadonlySet<ReconnectPhase> = new Set(["connecting", "reconnecting"]);

/** Phases in which a voice connection may be open; anything else tears it down. */
export function hasConnection(phase: ReconnectPhase): boolean {
  return phase === "connecting" || phase === "connected" || phase === "suspect" || phase === "reconnecting";
}

/** Integrity frames may only be captured while the voice session is fully connected. */
export function allowsIntegrityFrames(phase: ReconnectPhase): boolean {
  return phase === "connected";
}

/** Frames start only once the backend has acknowledged the connect or resume event of this attempt. */
export function integrityFramesReady(state: ReconnectState, ackedAttempt: number | null): boolean {
  return allowsIntegrityFrames(state.phase) && ackedAttempt === state.attempt;
}

function newAttempt(state: ReconnectState, phase: "connecting" | "reconnecting", retries: number): ReconnectState {
  return { ...state, phase, attempt: state.attempt + 1, retries, error: null, closeReason: null };
}

function interrupt(state: ReconnectState, reason: PauseReason): ReconnectState {
  return { ...state, phase: "interrupted", reason, interruptions: state.interruptions + 1, resumed: false };
}

function attemptFailed(state: ReconnectState, code: string, retryable: boolean): ReconnectState {
  if (!retryable || state.phase === "connecting") {
    return { ...state, phase: "failed", error: code };
  }
  const retries = state.retries + 1;
  if (retries >= RECONNECT_BACKOFF_MS.length) {
    return { ...state, phase: "exhausted", retries, error: code };
  }
  return { ...state, phase: "interrupted", retries };
}

export function reconnectReducer(state: ReconnectState, event: ReconnectEvent): ReconnectState {
  switch (event.type) {
    case "start":
      return state.phase === "idle" || state.phase === "failed" ? newAttempt(state, "connecting", 0) : state;

    case "connected":
      if (event.attempt !== state.attempt || !ATTEMPTING.has(state.phase)) {
        return state;
      }
      return {
        ...state,
        phase: "connected",
        retries: 0,
        reason: null,
        error: null,
        resumed: state.phase === "reconnecting",
        everConnected: true,
      };

    case "attempt_failed":
      if (event.attempt !== state.attempt || !ATTEMPTING.has(state.phase)) {
        return state;
      }
      return attemptFailed(state, event.code, event.retryable);

    case "signal":
      if (event.attempt !== state.attempt) {
        return state;
      }
      if (state.phase === "connected" || state.phase === "suspect") {
        return interrupt(state, event.reason);
      }
      if (ATTEMPTING.has(state.phase)) {
        return attemptFailed(state, "connection_failed", true);
      }
      return state;

    case "track_muted":
      return event.attempt === state.attempt && state.phase === "connected"
        ? { ...state, phase: "suspect", reason: event.reason }
        : state;

    case "track_unmuted":
      return event.attempt === state.attempt && state.phase === "suspect"
        ? { ...state, phase: "connected", reason: null }
        : state;

    case "grace_expired":
      return event.attempt === state.attempt && state.phase === "suspect"
        ? interrupt(state, state.reason ?? "connection")
        : state;

    case "idle_timeout":
      return event.attempt === state.attempt && (state.phase === "connected" || state.phase === "suspect")
        ? { ...state, phase: "exhausted", error: "idle_timeout", retries: 0, reason: null, resumed: false }
        : state;

    case "retry":
    case "online":
      return state.phase === "interrupted" ? newAttempt(state, "reconnecting", state.retries) : state;

    case "manual_retry":
      if (state.phase === "exhausted") {
        return newAttempt(state, "reconnecting", 0);
      }
      if (state.phase === "failed") {
        return newAttempt(state, state.everConnected ? "reconnecting" : "connecting", 0);
      }
      return state;

    case "resume":
      if (state.phase !== "closed" || state.closeReason !== "paused") {
        return state;
      }
      return newAttempt(state, state.everConnected ? "reconnecting" : "connecting", 0);

    case "close":
      return LIVE.has(state.phase) || state.phase === "exhausted" || state.phase === "failed"
        ? { ...state, phase: "closed", closeReason: event.reason }
        : state;
  }
}
