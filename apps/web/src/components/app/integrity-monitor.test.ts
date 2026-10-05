import type { IntegrityFrameResponse } from "@stackprep/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIntegrityMonitor, type FrameSubmitResult } from "./integrity-monitor";
import {
  INITIAL_RECONNECT_STATE,
  integrityFramesReady,
  type ReconnectEvent,
  reconnectReducer,
  type ReconnectState,
} from "./reconnect-machine";

const FRAME = "data:image/jpeg;base64,AAAA";
const OK: FrameSubmitResult = { ok: true, body: { status: "ok" } };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}

function setup(submit: (image: string) => Promise<FrameSubmitResult> = async () => OK) {
  const capture = vi.fn(() => FRAME);
  const submitSpy = vi.fn(submit);
  const results: IntegrityFrameResponse[] = [];
  const monitor = createIntegrityMonitor({
    capture,
    submit: submitSpy,
    onResult: (body) => results.push(body),
    intervalMs: 10_000,
  });
  return { monitor, capture, submit: submitSpy, results };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createIntegrityMonitor", () => {
  it("captures nothing until enabled, then one frame per interval", async () => {
    const { monitor, capture, submit } = setup();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(capture).not.toHaveBeenCalled();

    monitor.setEnabled(true);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(submit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(submit).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(submit).toHaveBeenCalledTimes(3);
    monitor.dispose();
  });

  it("stops capturing while disabled and resumes when enabled again", async () => {
    const { monitor, capture } = setup();
    monitor.setEnabled(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(capture).toHaveBeenCalledTimes(1);

    monitor.setEnabled(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(capture).toHaveBeenCalledTimes(1);

    monitor.setEnabled(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(capture).toHaveBeenCalledTimes(2);
    monitor.dispose();
  });

  it("never overlaps requests: the next frame waits for the slow one to settle", async () => {
    const slow = deferred<FrameSubmitResult>();
    const { monitor, submit } = setup(() => slow.promise);
    monitor.setEnabled(true);
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(submit).toHaveBeenCalledTimes(1);

    slow.resolve(OK);
    await vi.advanceTimersByTimeAsync(0);
    submit.mockImplementation(async () => OK);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(submit).toHaveBeenCalledTimes(2);
    monitor.dispose();
  });

  it("still reports a request in flight when disabled, but schedules nothing more", async () => {
    const pending = deferred<FrameSubmitResult>();
    const { monitor, submit, results } = setup(() => pending.promise);
    monitor.setEnabled(true);
    await vi.advanceTimersByTimeAsync(10_000);
    monitor.setEnabled(false);

    pending.resolve({ ok: true, body: { status: "warning", warning_number: 1, message: "Look at the screen." } });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(results).toEqual([{ status: "warning", warning_number: 1, message: "Look at the screen." }]);
    expect(submit).toHaveBeenCalledTimes(1);
    monitor.dispose();
  });

  it("stops for good after the interview is terminated", async () => {
    const { monitor, submit, results } = setup(async () => ({
      ok: true,
      body: { status: "terminated", warning_number: 3, message: "Ended." },
    }));
    monitor.setEnabled(true);
    await vi.advanceTimersByTimeAsync(10_000);
    monitor.setEnabled(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(results.map((r) => r.status)).toEqual(["terminated"]);
  });

  it("skips failed requests and empty captures without reporting", async () => {
    const { monitor, capture, submit, results } = setup(async () => ({ ok: false, code: "rate_limited" }));
    capture.mockReturnValueOnce(null as unknown as string);
    monitor.setEnabled(true);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(results).toEqual([]);
    monitor.dispose();
  });
});

describe("integrity frames across a reconnect", () => {
  function run(events: ReconnectEvent[], from: ReconnectState = INITIAL_RECONNECT_STATE) {
    return events.reduce(reconnectReducer, from);
  }

  it("waits for the backend to acknowledge the connect event", () => {
    const state = run([{ type: "start" }, { type: "connected", attempt: 1 }]);
    expect(integrityFramesReady(state, null)).toBe(false);
    expect(integrityFramesReady(state, 1)).toBe(true);
  });

  it("disables frames for the whole interruption and needs the resume ack of the new attempt", async () => {
    const { monitor, submit } = setup();
    let acked: number | null = null;
    let state = run([{ type: "start" }, { type: "connected", attempt: 1 }]);
    acked = 1;
    const apply = (event: ReconnectEvent) => {
      state = reconnectReducer(state, event);
      monitor.setEnabled(integrityFramesReady(state, acked));
    };
    monitor.setEnabled(integrityFramesReady(state, acked));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(submit).toHaveBeenCalledTimes(1);

    apply({ type: "track_muted", attempt: 1, reason: "camera" });
    for (let i = 0; i < 5; i++) {
      apply({ type: "signal", attempt: 1, cause: "track_ended", reason: "camera" });
    }
    expect(state.phase).toBe("interrupted");
    expect(state.interruptions).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(submit).toHaveBeenCalledTimes(1);

    apply({ type: "retry" });
    apply({ type: "connected", attempt: state.attempt });
    expect(state.phase).toBe("connected");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(submit).toHaveBeenCalledTimes(1);

    acked = state.attempt;
    monitor.setEnabled(integrityFramesReady(state, acked));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(submit).toHaveBeenCalledTimes(2);
    monitor.dispose();
  });

  it("an old attempt's ack never re-enables frames", () => {
    const state = run([
      { type: "start" },
      { type: "connected", attempt: 1 },
      { type: "signal", attempt: 1, cause: "offline", reason: "network" },
      { type: "online" },
      { type: "connected", attempt: 2 },
    ]);
    expect(integrityFramesReady(state, 1)).toBe(false);
    expect(integrityFramesReady(state, 2)).toBe(true);
  });
});
