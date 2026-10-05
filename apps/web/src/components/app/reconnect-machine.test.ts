import { describe, expect, it } from "vitest";
import {
  allowsIntegrityFrames,
  backoffDelay,
  hasConnection,
  INITIAL_RECONNECT_STATE,
  type ReconnectEvent,
  reconnectReducer,
  type ReconnectState,
  RECONNECT_BACKOFF_MS,
} from "./reconnect-machine";

const run = (events: ReconnectEvent[], from: ReconnectState = INITIAL_RECONNECT_STATE) =>
  events.reduce(reconnectReducer, from);

/** Started and connected on attempt 1. */
const live = run([{ type: "start" }, { type: "connected", attempt: 1 }]);

describe("reconnectReducer", () => {
  it("connects once per attempt and ignores stale completions", () => {
    const connecting = run([{ type: "start" }]);
    expect(connecting).toMatchObject({ phase: "connecting", attempt: 1 });
    expect(run([{ type: "connected", attempt: 0 }], connecting).phase).toBe("connecting");
    expect(live).toMatchObject({ phase: "connected", everConnected: true, resumed: false });
    expect(run([{ type: "start" }], live)).toBe(live);
  });

  it("turns a storm of signals for one drop into one interruption and one attempt", () => {
    const storm = run([
      { type: "signal", attempt: 1, cause: "channel_closed", reason: "connection" },
      { type: "signal", attempt: 1, cause: "connection_failed", reason: "network" },
      { type: "signal", attempt: 1, cause: "offline", reason: "network" },
      { type: "signal", attempt: 1, cause: "track_ended", reason: "microphone" },
    ], live);
    expect(storm).toMatchObject({ phase: "interrupted", interruptions: 1, reason: "connection", attempt: 1 });

    const retrying = run([{ type: "retry" }, { type: "online" }, { type: "retry" }], storm);
    expect(retrying).toMatchObject({ phase: "reconnecting", attempt: 2 });
  });

  it("ignores signals from a superseded attempt", () => {
    const reconnecting = run([{ type: "signal", attempt: 1, cause: "offline", reason: "network" }, { type: "retry" }], live);
    expect(run([{ type: "signal", attempt: 1, cause: "channel_closed", reason: "connection" }], reconnecting)).toBe(reconnecting);
    expect(run([{ type: "attempt_failed", attempt: 1, code: "connection_failed", retryable: true }], reconnecting))
      .toBe(reconnecting);
  });

  it("a failure during a reconnect attempt counts as a retry, not a new interruption", () => {
    const reconnecting = run([{ type: "signal", attempt: 1, cause: "offline", reason: "network" }, { type: "retry" }], live);
    const failed = run([{ type: "signal", attempt: 2, cause: "channel_closed", reason: "connection" }], reconnecting);
    expect(failed).toMatchObject({ phase: "interrupted", retries: 1, interruptions: 1 });
  });

  it("resumes on success and resets the retry count", () => {
    const resumed = run([
      { type: "signal", attempt: 1, cause: "track_ended", reason: "camera" },
      { type: "retry" },
      { type: "attempt_failed", attempt: 2, code: "realtime_unavailable", retryable: true },
      { type: "retry" },
      { type: "connected", attempt: 3 },
    ], live);
    expect(resumed).toMatchObject({ phase: "connected", attempt: 3, retries: 0, resumed: true, reason: null });
  });

  it("gives a muted track a grace period before interrupting", () => {
    const suspect = run([{ type: "track_muted", attempt: 1, reason: "microphone" }], live);
    expect(suspect).toMatchObject({ phase: "suspect", reason: "microphone", interruptions: 0 });
    expect(run([{ type: "track_unmuted", attempt: 1 }], suspect)).toMatchObject({ phase: "connected", interruptions: 0 });
    expect(run([{ type: "grace_expired", attempt: 1 }], suspect)).toMatchObject({
      phase: "interrupted",
      reason: "microphone",
      interruptions: 1,
    });
    expect(run([{ type: "grace_expired", attempt: 0 }], suspect)).toBe(suspect);
    expect(run([{ type: "signal", attempt: 1, cause: "track_ended", reason: "microphone" }], suspect).phase).toBe("interrupted");
  });

  it("is exhausted after the backoff schedule and reconnects manually", () => {
    let state = run([{ type: "signal", attempt: 1, cause: "offline", reason: "network" }], live);
    for (let i = 0; i < RECONNECT_BACKOFF_MS.length; i++) {
      state = run([{ type: "retry" }, { type: "attempt_failed", attempt: state.attempt + 1, code: "connection_failed", retryable: true }], state);
    }
    expect(state).toMatchObject({ phase: "exhausted", error: "connection_failed", retries: RECONNECT_BACKOFF_MS.length });
    expect(run([{ type: "retry" }, { type: "online" }], state)).toBe(state);
    expect(run([{ type: "manual_retry" }], state)).toMatchObject({ phase: "reconnecting", retries: 0, attempt: state.attempt + 1 });
  });

  it("stops on a failure a reconnect cannot fix", () => {
    const state = run([
      { type: "signal", attempt: 1, cause: "offline", reason: "network" },
      { type: "retry" },
      { type: "attempt_failed", attempt: 2, code: "interview_not_active", retryable: false },
    ], live);
    expect(state).toMatchObject({ phase: "failed", error: "interview_not_active" });
  });

  it("a failed first connection waits for the user, and a retry starts fresh", () => {
    const failed = run([{ type: "start" }, { type: "attempt_failed", attempt: 1, code: "connection_failed", retryable: true }]);
    expect(failed).toMatchObject({ phase: "failed", error: "connection_failed" });
    expect(run([{ type: "manual_retry" }], failed)).toMatchObject({ phase: "connecting", attempt: 2 });
    expect(run([{ type: "start" }], failed)).toMatchObject({ phase: "connecting", attempt: 2 });
  });

  it("closes from any live phase and ignores later signals", () => {
    const closed = run([{ type: "close", reason: "terminated" }], live);
    expect(closed).toMatchObject({ phase: "closed", closeReason: "terminated" });
    expect(run([{ type: "signal", attempt: 1, cause: "offline", reason: "network" }, { type: "retry" }], closed)).toBe(closed);
  });
});

describe("helpers", () => {
  it("backs off 2, 4, 8, 16 seconds", () => {
    expect([0, 1, 2, 3, 9].map(backoffDelay)).toEqual([2_000, 4_000, 8_000, 16_000, 16_000]);
  });

  it("allows integrity frames only while fully connected", () => {
    const phases = ["idle", "connecting", "connected", "suspect", "interrupted", "reconnecting", "exhausted", "failed", "closed"] as const;
    expect(phases.filter(allowsIntegrityFrames)).toEqual(["connected"]);
    expect(phases.filter(hasConnection)).toEqual(["connecting", "connected", "suspect", "reconnecting"]);
  });
});
