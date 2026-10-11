// SSE load scenario for GET /interviews/:id/events. Needs the k6 binary built by build-k6.ts
// (k6 + xk6-sse); stock k6 buffers whole responses and cannot time individual frames.
//
// Two scenarios share one wall clock (START_AT, epoch ms):
//   readers: one per interview, holds the stream and reconnects the way the web client does
//            (`?last_event_id=` after a clean close, jittered backoff, polling fallback after 3 failures).
//   writers: one per interview, replays schedule.json through POST /interviews/:id/events, then
//            completes the interview and saves a report through the service-role RPCs.
// Every frame, connection, and write is logged as one JSON line; analyze.ts joins them with the
// database rows after the run.
import exec from "k6/execution";
import http from "k6/http";
import { sleep } from "k6";
import sse from "k6/x/sse";

const API_URL = __ENV.API_URL;
const ANON_KEY = __ENV.ANON_KEY;
const SERVICE_KEY = __ENV.SERVICE_ROLE_KEY;
const START_AT = Number(__ENV.START_AT);
const CONNECT_RAMP_MS = Number(__ENV.CONNECT_RAMP_MS);
const DEADLINE_AT = Number(__ENV.DEADLINE_AT);
const COUNT = Number(__ENV.COUNT);

const fixtures = JSON.parse(open(__ENV.FIXTURES_PATH));
const schedule = JSON.parse(open(__ENV.SCHEDULE_PATH));

const STREAM_RETRY_MS = 3000;
const MAX_BACKOFF_MS = 30000;
const MAX_FAILURES = 3;
const TOTAL_SECONDS = Math.ceil((DEADLINE_AT - START_AT) / 1000) + 60;

export const options = {
  discardResponseBodies: false,
  summaryTrendStats: ["min", "med", "p(95)", "p(99)", "max", "count"],
  scenarios: {
    readers: {
      executor: "per-vu-iterations",
      exec: "reader",
      vus: COUNT,
      iterations: 1,
      maxDuration: `${TOTAL_SECONDS}s`,
    },
    writers: {
      executor: "per-vu-iterations",
      exec: "writer",
      vus: COUNT,
      iterations: 1,
      maxDuration: `${TOTAL_SECONDS}s`,
    },
  },
};

function log(record) {
  console.log(JSON.stringify(record));
}

function sleepUntil(at) {
  const ms = at - Date.now();
  if (ms > 0) {
    sleep(ms / 1000);
  }
}

function eventsUrl(interviewId) {
  return `${API_URL}/functions/v1/interviews/${interviewId}/events`;
}

/** mulberry32, same as lib.ts; k6 v2 has no `randomSeed` option, so backoff jitter uses this. */
function createRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function reader() {
  const iv = exec.scenario.iterationInTest;
  const fixture = fixtures[iv];
  const random = createRng(Number(__ENV.SEED) + iv);
  sleepUntil(START_AT + Math.floor((iv * CONNECT_RAMP_MS) / COUNT));

  let cursor = null;
  let failures = 0;
  let conn = 0;
  let done = false;
  while (!done && Date.now() < DEADLINE_AT) {
    const url = cursor ? `${eventsUrl(fixture.interviewId)}?last_event_id=${encodeURIComponent(cursor)}` : eventsUrl(fixture.interviewId);
    const requestedAt = Date.now();
    let openedAt = null;
    let frames = 0;
    let errorMessage = null;
    const params = {
      method: "GET",
      headers: { Authorization: `Bearer ${fixture.token}`, apikey: ANON_KEY, Accept: "text/event-stream" },
      tags: { name: "stream" },
    };
    let response = null;
    try {
      response = sse.open(url, params, (client) => {
        client.on("open", () => {
          openedAt = Date.now();
        });
        client.on("event", (event) => {
          const t = Date.now();
          if (!event.id) {
            return;
          }
          cursor = event.id;
          frames++;
          let data = null;
          try {
            data = JSON.parse(event.data);
          } catch {
            // Logged with null data; analyze.ts counts it as malformed.
          }
          log({ k: "frame", iv, conn, t, ev: event.name, id: event.id, data });
          if (event.name === "report_ready") {
            done = true;
            client.close();
          }
        });
        client.on("error", (e) => {
          errorMessage = String(e && typeof e.error === "function" ? e.error() : e);
        });
      });
    } catch (e) {
      errorMessage = String(e);
    }
    const closedAt = Date.now();
    const status = response ? response.status : 0;
    log({ k: "conn", iv, conn, requestedAt, openedAt, closedAt, status, frames, done, error: errorMessage });
    conn++;

    if (done) {
      break;
    }
    if (status === 200) {
      failures = 0;
      sleep(STREAM_RETRY_MS / 1000);
      continue;
    }
    if (status === 400) {
      cursor = null;
    }
    failures++;
    if (failures >= MAX_FAILURES) {
      log({ k: "fallback", iv, t: Date.now() });
      return;
    }
    const delay = Math.min(MAX_BACKOFF_MS, STREAM_RETRY_MS * 2 ** (failures - 1));
    sleep((delay / 2 + (delay / 2) * random()) / 1000);
  }
}

/** Deterministic, RFC 4122 v4-shaped client event id for (interview, action). */
function clientEventId(iv, action) {
  const ivHex = iv.toString(16).padStart(4, "0");
  const actionHex = action.toString(16).padStart(12, "0");
  return `5eed${ivHex}-0000-4000-8000-${actionHex}`;
}

function turnContent(k, chars) {
  const base = `Load test turn ${k}. The candidate explains how the request flows through the service. `;
  let text = base;
  while (text.length < chars) {
    text += base;
  }
  return text.slice(0, chars);
}

function rpc(name, body) {
  return http.post(`${API_URL}/rest/v1/rpc/${name}`, JSON.stringify(body), {
    headers: { Authorization: `Bearer ${SERVICE_KEY}`, apikey: SERVICE_KEY, "Content-Type": "application/json" },
    tags: { name: `rpc_${name}` },
  });
}

export function writer() {
  const iv = exec.scenario.iterationInTest;
  const fixture = fixtures[iv];
  const base = START_AT + schedule.offsetsMs[iv];
  const headers = {
    Authorization: `Bearer ${fixture.token}`,
    apikey: ANON_KEY,
    "Content-Type": "application/json",
  };

  schedule.actions.forEach((action, i) => {
    const plannedAt = base + action.atMs;
    sleepUntil(plannedAt);
    const cei = clientEventId(iv, i);
    const occurredAt = new Date().toISOString();
    const body = action.kind === "transcript_turn"
      ? {
        type: "transcript_turn",
        client_event_id: cei,
        role: action.role,
        content: turnContent(i, schedule.turnContentChars),
        item_id: `item_lt_${iv}_${i}`,
        occurred_at: occurredAt,
      }
      : { type: action.kind, client_event_id: cei, occurred_at: occurredAt };
    const startedAt = Date.now();
    const res = http.post(eventsUrl(fixture.interviewId), JSON.stringify(body), { headers, tags: { name: `write_${action.kind}` } });
    log({ k: "write", iv, i, kind: action.kind, cei, plannedAt, startedAt, endedAt: Date.now(), status: res.status });
  });

  sleepUntil(base + schedule.completeAtMs);
  let startedAt = Date.now();
  const completed = rpc("complete_interview", {
    p_interview_id: fixture.interviewId,
    p_user_id: fixture.userId,
    p_reason: "completed_early",
  });
  log({ k: "write", iv, kind: "complete", plannedAt: base + schedule.completeAtMs, startedAt, endedAt: Date.now(), status: completed.status });

  sleepUntil(base + schedule.completeAtMs + schedule.reportAfterMs);
  startedAt = Date.now();
  const requested = rpc("request_report", { p_interview_id: fixture.interviewId, p_user_id: fixture.userId });
  let status = requested.status;
  if (status === 200) {
    const saved = rpc("save_report", {
      p_interview_id: fixture.interviewId,
      p_job_id: requested.json(),
      p_content: { load_test: true },
    });
    status = saved.status;
  }
  log({
    k: "write",
    iv,
    kind: "report",
    plannedAt: base + schedule.completeAtMs + schedule.reportAfterMs,
    startedAt,
    endedAt: Date.now(),
    status,
  });
}
