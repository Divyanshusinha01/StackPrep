import {
  formatInterviewStreamCursor,
  INTERVIEW_STREAM_HEARTBEAT_MS,
  INTERVIEW_STREAM_RETRY_MS,
  type InterviewStreamCursor,
  type InterviewStreamEvent,
  interviewStreamEventSchema,
  type InterviewStreamStatus,
} from "@stackprep/shared";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Status transitions streamed as `interview_status`; every other event type stays internal. */
const STATUS_EVENT_TYPES = { start: "in_progress", completion: "completed", termination: "terminated" } as const;

export type StatusEventType = keyof typeof STATUS_EVENT_TYPES;

export interface StatusEventRow {
  sequence: number;
  event_type: StatusEventType;
  occurred_at: string;
  created_at: string;
}

export interface PersistedTurnRow {
  sequence: number;
  role: "ai" | "user";
  client_event_id: string;
  item_id: string | null;
  created_at: string;
}

/** Reads made with the caller's client, so RLS limits every result to their own rows. */
export interface InterviewStreamReader {
  /** Status events with `sequence > afterSequence`, ascending, at most `limit`. */
  listStatusEvents(interviewId: string, afterSequence: number, limit: number): Promise<StatusEventRow[]>;
  /** Candidate and interviewer turns with `sequence > afterSequence`, ascending, at most `limit`. */
  listPersistedTurns(interviewId: string, afterSequence: number, limit: number): Promise<PersistedTurnRow[]>;
  /** `reports.generated_at`, or null while there is no report. */
  getReportGeneratedAt(interviewId: string): Promise<string | null>;
}

export function createInterviewStreamReader(client: SupabaseClient): InterviewStreamReader {
  return {
    async listStatusEvents(interviewId, afterSequence, limit) {
      const { data, error } = await client
        .from("interview_events")
        .select("sequence, event_type, occurred_at, created_at")
        .eq("interview_id", interviewId)
        .in("event_type", Object.keys(STATUS_EVENT_TYPES))
        .gt("sequence", afterSequence)
        .order("sequence")
        .limit(limit);
      if (error) {
        throw new Error(`Failed to load status events: ${error.message}`);
      }
      return (data ?? []) as StatusEventRow[];
    },
    async listPersistedTurns(interviewId, afterSequence, limit) {
      const { data, error } = await client
        .from("interview_messages")
        .select("sequence, role, client_event_id, item_id:metadata->>item_id, created_at")
        .eq("interview_id", interviewId)
        .in("role", ["ai", "user"])
        .gt("sequence", afterSequence)
        .order("sequence")
        .limit(limit);
      if (error) {
        throw new Error(`Failed to load persisted turns: ${error.message}`);
      }
      return (data ?? []) as PersistedTurnRow[];
    },
    async getReportGeneratedAt(interviewId) {
      const { data, error } = await client
        .from("reports")
        .select("generated_at")
        .eq("interview_id", interviewId)
        .maybeSingle();
      if (error) {
        throw new Error(`Failed to load report: ${error.message}`);
      }
      return (data?.generated_at as string | undefined) ?? null;
    },
  };
}

export interface StreamFrame {
  /** The cursor after this frame. */
  id: string;
  event: InterviewStreamEvent;
}

export interface PollResult {
  frames: StreamFrame[];
  cursor: InterviewStreamCursor;
  /** `report_ready` was emitted; the stream ends. */
  done: boolean;
}

export const STREAM_BATCH_LIMIT = 100;

type Pending =
  | { source: 0; createdAt: string; sequence: number; row: StatusEventRow }
  | { source: 1; createdAt: string; sequence: number; row: PersistedTurnRow };

/**
 * One read of all three sources strictly after `cursor`. Frames are merged by `created_at`, then
 * source, then sequence; each frame's id is the cursor advanced past it. `report_ready` is only
 * emitted once both batches are drained, so it is always the last frame of the connection.
 */
export async function pollStreamEvents(
  reader: InterviewStreamReader,
  interviewId: string,
  cursor: InterviewStreamCursor,
  limit = STREAM_BATCH_LIMIT,
): Promise<PollResult> {
  const [statuses, turns, reportAt] = await Promise.all([
    reader.listStatusEvents(interviewId, cursor.eventSequence, limit),
    reader.listPersistedTurns(interviewId, cursor.turnSequence, limit),
    cursor.reportSent ? Promise.resolve(null) : reader.getReportGeneratedAt(interviewId),
  ]);

  const pending: Pending[] = [
    ...statuses
      .filter((row) => row.sequence > cursor.eventSequence && row.event_type in STATUS_EVENT_TYPES)
      .map((row) => ({ source: 0 as const, createdAt: row.created_at, sequence: row.sequence, row })),
    ...turns
      .filter((row) => row.sequence > cursor.turnSequence)
      .map((row) => ({ source: 1 as const, createdAt: row.created_at, sequence: row.sequence, row })),
  ].sort((a, b) =>
    Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.source - b.source || a.sequence - b.sequence
  );

  let next = { ...cursor };
  const frames: StreamFrame[] = [];
  for (const item of pending) {
    let event: InterviewStreamEvent;
    if (item.source === 0) {
      // Out-of-order rows across sources never move a component backwards.
      if (item.row.sequence <= next.eventSequence) {
        continue;
      }
      next = { ...next, eventSequence: item.row.sequence };
      const status: InterviewStreamStatus = STATUS_EVENT_TYPES[item.row.event_type];
      event = {
        event: "interview_status",
        data: { status, event_sequence: item.row.sequence, occurred_at: new Date(item.row.occurred_at).toISOString() },
      };
    } else {
      if (item.row.sequence <= next.turnSequence) {
        continue;
      }
      next = { ...next, turnSequence: item.row.sequence };
      event = {
        event: "turn_persisted",
        data: {
          turn_sequence: item.row.sequence,
          role: item.row.role,
          client_event_id: item.row.client_event_id,
          ...(item.row.item_id ? { item_id: item.row.item_id } : {}),
        },
      };
    }
    frames.push({ id: formatInterviewStreamCursor(next), event: interviewStreamEventSchema.parse(event) });
  }

  const drained = statuses.length < limit && turns.length < limit;
  if (reportAt && drained && !next.reportSent) {
    next = { ...next, reportSent: true };
    frames.push({
      id: formatInterviewStreamCursor(next),
      event: interviewStreamEventSchema.parse({
        event: "report_ready",
        data: { generated_at: new Date(reportAt).toISOString() },
      }),
    });
    return { frames, cursor: next, done: true };
  }
  return { frames, cursor: next, done: false };
}

export function encodeFrame(frame: StreamFrame): string {
  return `id: ${frame.id}\nevent: ${frame.event.event}\ndata: ${JSON.stringify(frame.event.data)}\n\n`;
}

export const HEARTBEAT_FRAME = ": heartbeat\n\n";

export interface StreamTiming {
  /** Interval between source reads. */
  pollMs: number;
  heartbeatMs: number;
  /** Connection lifetime; must stay under the Edge Function wall-clock limit (150 s on the free plan). */
  lifetimeMs: number;
  retryMs: number;
}

export const DEFAULT_STREAM_TIMING: StreamTiming = {
  pollMs: 1_500,
  heartbeatMs: INTERVIEW_STREAM_HEARTBEAT_MS,
  lifetimeMs: 140_000,
  retryMs: INTERVIEW_STREAM_RETRY_MS,
};

export interface InterviewStreamOptions {
  reader: InterviewStreamReader;
  interviewId: string;
  cursor: InterviewStreamCursor;
  /** The request's signal; the stream stops when the client goes away. */
  signal: AbortSignal;
  timing: StreamTiming;
  onError: (err: unknown) => void;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * The SSE body: a `retry:` hint, then frames as rows appear, a comment heartbeat when idle, and a
 * clean close after `report_ready`, the lifetime, a read failure, or the client aborting.
 */
export function createInterviewStream(
  { reader, interviewId, cursor, signal, timing, onError }: InterviewStreamOptions,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const stop = new AbortController();
  const onAbort = () => stop.abort();
  signal.addEventListener("abort", onAbort, { once: true });

  async function run(controller: ReadableStreamDefaultController<Uint8Array>) {
    const write = (text: string) => controller.enqueue(encoder.encode(text));
    const deadline = Date.now() + timing.lifetimeMs;
    let position = cursor;
    let lastWrite = Date.now();
    try {
      write(`retry: ${timing.retryMs}\n\n`);
      while (!stop.signal.aborted) {
        const result = await pollStreamEvents(reader, interviewId, position);
        if (stop.signal.aborted) {
          break;
        }
        for (const frame of result.frames) {
          write(encodeFrame(frame));
        }
        position = result.cursor;
        if (result.frames.length > 0) {
          lastWrite = Date.now();
        }
        if (result.done || Date.now() >= deadline) {
          break;
        }
        if (Date.now() - lastWrite >= timing.heartbeatMs) {
          write(HEARTBEAT_FRAME);
          lastWrite = Date.now();
        }
        await sleep(Math.min(timing.pollMs, deadline - Date.now()), stop.signal);
      }
    } catch (err) {
      if (!stop.signal.aborted) {
        onError(err);
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      try {
        controller.close();
      } catch {
        // Already closed by a cancel.
      }
    }
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      void run(controller);
    },
    cancel() {
      stop.abort();
    },
  });
}
