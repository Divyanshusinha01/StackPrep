import { INTERVIEW_STREAM_RETRY_MS, type InterviewStreamEvent, interviewStreamEventSchema } from "@stackprep/shared";

/**
 * Fetch-based reader for `GET /interviews/:id/events`. Native `EventSource` cannot send the
 * `Authorization` header, so frames are parsed here. The last received `id:` is the resume cursor:
 * it is sent on every reconnect, and the server replays only strictly later events.
 */

export interface SseFrame {
  id: string | null;
  event: string;
  data: string;
}

export interface SseParser {
  push(chunk: string): void;
}

/** Incremental `text/event-stream` parser; frames may arrive split across any number of chunks. */
export function createSseParser(onFrame: (frame: SseFrame) => void, onRetry?: (ms: number) => void): SseParser {
  let buffer = "";
  let skipLineFeed = false;
  let id: string | null = null;
  let event = "";
  let data: string[] = [];

  const dispatch = () => {
    if (data.length > 0) {
      onFrame({ id, event: event || "message", data: data.join("\n") });
    }
    id = null;
    event = "";
    data = [];
  };

  const line = (text: string) => {
    if (text === "") {
      dispatch();
      return;
    }
    if (text.startsWith(":")) {
      return;
    }
    const colon = text.indexOf(":");
    const field = colon === -1 ? text : text.slice(0, colon);
    let value = colon === -1 ? "" : text.slice(colon + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }
    if (field === "data") {
      data.push(value);
    } else if (field === "event") {
      event = value;
    } else if (field === "id" && !value.includes("\0")) {
      id = value;
    } else if (field === "retry" && /^\d+$/.test(value)) {
      onRetry?.(Number(value));
    }
  };

  return {
    push(chunk) {
      // A chunk ending in "\r" may be the first half of "\r\n"; drop the "\n" half if it follows.
      const text = skipLineFeed && chunk.startsWith("\n") ? chunk.slice(1) : chunk;
      skipLineFeed = text.endsWith("\r");
      buffer += text;
      const lines = buffer.split(/\r\n|\r|\n/);
      buffer = lines.pop() ?? "";
      for (const entry of lines) {
        line(entry);
      }
    },
  };
}

export const STREAM_MAX_FAILURES = 3;
const MAX_BACKOFF_MS = 30_000;

export interface InterviewEventStreamOptions {
  /** Stream URL without a cursor; `last_event_id` is appended on reconnects. */
  url: string;
  /** Fresh auth headers per connect; null when there is no session (counted as a failure). */
  getHeaders(): Promise<Record<string, string> | null>;
  onEvent(event: InterviewStreamEvent): void;
  /** Called once after `maxFailures` consecutive failed connects; the stream has stopped. */
  onFallback(): void;
  fetch?: typeof fetch;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  maxFailures?: number;
  random?: () => number;
}

export interface InterviewEventStream {
  stop(): void;
  /** The last received event id, or null before the first one. */
  cursor(): string | null;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
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
 * Connects, reads until the server closes (lifetime, `report_ready`) or the connection fails, and
 * reconnects from the last id. A connect that gets a 200 stream resets the failure count; after
 * `maxFailures` failed connects in a row the reader gives up and calls `onFallback`.
 */
export function startInterviewEventStream({
  url,
  getHeaders,
  onEvent,
  onFallback,
  fetch: fetchImpl = globalThis.fetch.bind(globalThis),
  sleep = abortableSleep,
  maxFailures = STREAM_MAX_FAILURES,
  random = Math.random,
}: InterviewEventStreamOptions): InterviewEventStream {
  const stopper = new AbortController();
  let cursor: string | null = null;
  let retryMs = INTERVIEW_STREAM_RETRY_MS;

  async function connectOnce(): Promise<{ connected: boolean; done: boolean }> {
    const headers = await getHeaders();
    if (!headers) {
      return { connected: false, done: false };
    }
    const target = new URL(url);
    if (cursor) {
      target.searchParams.set("last_event_id", cursor);
    }
    const res = await fetchImpl(target.toString(), {
      headers: { ...headers, Accept: "text/event-stream" },
      cache: "no-store",
      signal: stopper.signal,
    });
    if (!res.ok || !res.body) {
      if (res.status === 400) {
        // Our cursor always comes from the server; if it is refused, start over rather than loop.
        cursor = null;
      }
      await res.body?.cancel().catch(() => {});
      return { connected: false, done: false };
    }

    let done = false;
    const parser = createSseParser(
      (frame) => {
        if (done || frame.id === null) {
          return;
        }
        cursor = frame.id;
        let data: unknown;
        try {
          data = JSON.parse(frame.data);
        } catch {
          return;
        }
        const parsed = interviewStreamEventSchema.safeParse({ event: frame.event, data });
        if (!parsed.success) {
          return;
        }
        if (parsed.data.event === "report_ready") {
          done = true;
        }
        onEvent(parsed.data);
      },
      (ms) => {
        retryMs = ms;
      },
    );
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    try {
      while (!done) {
        const { value, done: ended } = await reader.read();
        if (ended) {
          break;
        }
        parser.push(value);
      }
    } catch {
      // A dropped connection after a successful connect: reconnect from the cursor.
    } finally {
      await reader.cancel().catch(() => {});
    }
    return { connected: true, done };
  }

  async function run() {
    let failures = 0;
    while (!stopper.signal.aborted) {
      let outcome = { connected: false, done: false };
      try {
        outcome = await connectOnce();
      } catch {
        // Network error or abort; handled below.
      }
      if (stopper.signal.aborted || outcome.done) {
        return;
      }
      if (outcome.connected) {
        failures = 0;
        await sleep(retryMs, stopper.signal);
        continue;
      }
      failures++;
      if (failures >= maxFailures) {
        onFallback();
        return;
      }
      const delay = Math.min(MAX_BACKOFF_MS, retryMs * 2 ** (failures - 1));
      await sleep(delay / 2 + (delay / 2) * random(), stopper.signal);
    }
  }

  void run();

  return {
    stop() {
      stopper.abort();
    },
    cursor() {
      return cursor;
    },
  };
}
