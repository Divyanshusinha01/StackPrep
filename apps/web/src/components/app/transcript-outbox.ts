import {
  type InterviewEventAck,
  interviewEventAckSchema,
  type InterviewEventRequest,
  interviewEventRequestSchema,
  type PauseReason,
  TRANSCRIPT_TURN_MAX_CHARS,
} from "@stackprep/shared";
import type { TranscriptState } from "./realtime-transcript";

/**
 * Ordered, persistent send buffer for `POST /interviews/:id/events`. Every item gets its
 * `client_event_id` once, so a retry after a lost response is recognised as a duplicate.
 * Sequences are assigned by the server; sending one item at a time keeps them in the order
 * items were enqueued, and no client state is needed to continue after a refresh or on
 * another device.
 */

export type OutboxInput =
  | { type: "transcript_turn"; role: "ai" | "user"; content: string; item_id: string; interrupted?: boolean }
  | { type: "connected" | "disconnected" | "resume" }
  | { type: "pause"; reason: PauseReason };

export type SendResult =
  | { ok: true; ack: unknown }
  | { ok: false; retryable: boolean; code: string };

export interface OutboxStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface OutboxOptions {
  storageKey: string;
  send(item: InterviewEventRequest): Promise<SendResult>;
  storage?: OutboxStorage | null;
  /** A non-retryable failure or a contract mismatch; the item has been dropped. */
  onDrop?(item: InterviewEventRequest, code: string): void;
  /** The backend stored the item (created or duplicate). */
  onAck?(item: InterviewEventRequest, ack: InterviewEventAck): void;
  /** Registers `wake` for events that make an immediate retry worthwhile; returns an unsubscribe. */
  subscribeWake?(wake: () => void): () => void;
  randomId?: () => string;
  now?: () => Date;
  random?: () => number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export interface TranscriptOutbox {
  enqueue(input: OutboxInput): InterviewEventRequest;
  /** Sends now, skipping any backoff. Resolves once the queue is empty or a send has failed. */
  flush(): Promise<void>;
  pending(): readonly InterviewEventRequest[];
  /**
   * The server reported this item as stored (e.g. via the event stream after a lost response):
   * drop it without resending. An item that is being sent is left to its own ack. True if removed.
   */
  confirm(clientEventId: string): boolean;
  /** Stops sending. Unsent items stay persisted for the next outbox on this key. */
  dispose(): void;
}

interface PersistedState {
  queue: InterviewEventRequest[];
}

export function outboxStorageKey(interviewId: string): string {
  return `stackprep:interview-outbox:${interviewId}`;
}

function load(storage: OutboxStorage | null, key: string): PersistedState {
  let raw: unknown;
  try {
    raw = JSON.parse(storage?.getItem(key) ?? "null");
  } catch {
    return { queue: [] };
  }
  const queue = (raw as { queue?: unknown } | null)?.queue;
  return {
    queue: Array.isArray(queue)
      ? queue.flatMap((item) => {
          const parsed = interviewEventRequestSchema.safeParse(item);
          return parsed.success ? [parsed.data] : [];
        })
      : [],
  };
}

function ackMatches(item: InterviewEventRequest, ack: InterviewEventAck): boolean {
  return ack.type === item.type && ack.client_event_id === item.client_event_id;
}

export function createTranscriptOutbox({
  storageKey,
  send,
  storage = null,
  onDrop,
  onAck,
  subscribeWake,
  randomId = () => crypto.randomUUID(),
  now = () => new Date(),
  random = Math.random,
  baseDelayMs = 500,
  maxDelayMs = 30_000,
}: OutboxOptions): TranscriptOutbox {
  const state = load(storage, storageKey);
  let running = false;
  let inFlight: InterviewEventRequest | null = null;
  let disposed = false;
  let attempt = 0;
  let backoff: { timer: ReturnType<typeof setTimeout>; resolve: () => void } | null = null;
  let settleWaiters: (() => void)[] = [];

  const persist = () => {
    try {
      if (state.queue.length === 0) {
        storage?.removeItem(storageKey);
      } else {
        storage?.setItem(storageKey, JSON.stringify(state));
      }
    } catch {
      // Storage full or unavailable: keep sending from memory.
    }
  };

  const settle = () => {
    const waiters = settleWaiters;
    settleWaiters = [];
    waiters.forEach((resolve) => resolve());
  };

  const wake = () => {
    if (backoff) {
      clearTimeout(backoff.timer);
      backoff.resolve();
      backoff = null;
    }
    void pump();
  };

  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      backoff = {
        resolve,
        timer: setTimeout(() => {
          backoff = null;
          resolve();
        }, ms),
      };
    });

  const drop = (item: InterviewEventRequest, code: string) => {
    state.queue.shift();
    attempt = 0;
    persist();
    onDrop?.(item, code);
  };

  async function pump(): Promise<void> {
    if (running || disposed) {
      return;
    }
    running = true;
    try {
      while (state.queue.length > 0 && !disposed) {
        const item = state.queue[0];
        let result: SendResult;
        inFlight = item;
        try {
          result = await send(item);
        } catch {
          result = { ok: false, retryable: true, code: "network_error" };
        } finally {
          inFlight = null;
        }
        if (disposed) {
          return;
        }
        if (result.ok) {
          const ack = interviewEventAckSchema.safeParse(result.ack);
          if (!ack.success || !ackMatches(item, ack.data)) {
            drop(item, "contract_error");
            continue;
          }
          state.queue.shift();
          attempt = 0;
          persist();
          onAck?.(item, ack.data);
          continue;
        }
        if (!result.retryable) {
          drop(item, result.code);
          continue;
        }
        attempt++;
        settle();
        const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
        await wait(delay / 2 + (delay / 2) * random());
      }
    } finally {
      running = false;
      settle();
    }
  }

  const unsubscribe = subscribeWake?.(wake) ?? (() => {});

  if (state.queue.length > 0) {
    void pump();
  }

  return {
    enqueue(input) {
      const base = { client_event_id: randomId(), occurred_at: now().toISOString() };
      const item: InterviewEventRequest =
        input.type === "transcript_turn"
          ? {
              type: "transcript_turn",
              ...base,
              role: input.role,
              content: input.content.trim().slice(0, TRANSCRIPT_TURN_MAX_CHARS).trim(),
              item_id: input.item_id,
              ...(input.interrupted ? { interrupted: true } : {}),
            }
          : input.type === "pause"
            ? { type: "pause", ...base, reason: input.reason }
            : { type: input.type, ...base };
      state.queue.push(item);
      persist();
      if (!disposed) {
        void pump();
      }
      return item;
    },
    flush() {
      if (disposed || (state.queue.length === 0 && !running)) {
        return Promise.resolve();
      }
      const settled = new Promise<void>((resolve) => settleWaiters.push(resolve));
      wake();
      return settled;
    },
    pending() {
      return [...state.queue];
    },
    confirm(clientEventId) {
      const index = state.queue.findIndex((item) => item.client_event_id === clientEventId);
      if (index === -1 || state.queue[index] === inFlight) {
        return false;
      }
      state.queue.splice(index, 1);
      persist();
      if (index === 0) {
        // The head was waiting out a backoff; move on to the next item now.
        attempt = 0;
        wake();
      }
      return true;
    },
    dispose() {
      disposed = true;
      unsubscribe();
      if (backoff) {
        clearTimeout(backoff.timer);
        backoff.resolve();
        backoff = null;
      }
      settle();
    },
  };
}

/**
 * Flushes until no transcript turn is waiting to be stored, or `timeoutMs` passes. Used before a
 * reconnect so the backend's recap includes every finalized answer. True if every turn was acked.
 */
export async function drainTurns(outbox: TranscriptOutbox, timeoutMs = 5_000, pauseMs = 500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const hasTurns = () => outbox.pending().some((item) => item.type === "transcript_turn");
  while (hasTurns()) {
    if (Date.now() >= deadline) {
      return false;
    }
    await outbox.flush();
    if (hasTurns()) {
      await new Promise((resolve) => setTimeout(resolve, pauseMs));
    }
  }
  return true;
}

/** Retry as soon as the browser is back online or the tab becomes visible. */
export function browserWakeSignals(wake: () => void): () => void {
  const onVisibility = () => {
    if (document.visibilityState === "visible") {
      wake();
    }
  };
  window.addEventListener("online", wake);
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    window.removeEventListener("online", wake);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}

/**
 * Turns that became final since the last call, as outbox input. `seen` holds the item ids
 * already emitted, so a turn is never enqueued twice.
 */
export function newlyFinalTurns(state: TranscriptState, seen: Set<string>): OutboxInput[] {
  const out: OutboxInput[] = [];
  for (const role of ["ai", "user"] as const) {
    for (const turn of state[role]) {
      if (!turn.final || seen.has(turn.itemId) || !turn.text.trim()) {
        continue;
      }
      seen.add(turn.itemId);
      out.push({
        type: "transcript_turn",
        role,
        content: turn.text,
        item_id: turn.itemId,
        ...(turn.interrupted ? { interrupted: true } : {}),
      });
    }
  }
  return out;
}
