import { assert, assertEquals } from "@std/assert";
import {
  apiErrorSchema,
  interviewEventAckSchema,
  type InterviewPlan,
  type PlanningState,
  realtimeSessionResponseSchema,
  VOICE_LIMIT_SECONDS,
} from "@stackprep/shared";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import type { Authenticate } from "../_shared/auth.ts";
import { CREDENTIAL_TTL_SECONDS, createRealtimeClient } from "../_shared/realtime/openai-realtime.ts";
import {
  createInterviewsHandler,
  type InterviewReader,
  type InterviewRow,
  type InterviewStore,
  type RecordResult,
  type TranscriptTurnRecord,
  type VoiceEvent,
  type VoiceEventRecord,
  voiceSecondsUsed,
} from "./handler.ts";

const userId = "aaaaaaaa-0000-4000-8000-000000000001";
const webOrigin = "http://localhost:3000";
const INTERVIEW_ID = "ffffffff-0000-4000-8000-000000000001";
const WORKSPACE_ID = "cccccccc-0000-4000-8000-000000000001";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const API_KEY = "sk-live-SUPERSECRET";
const NOW = new Date("2026-10-05T12:00:00.000Z");

const plan: InterviewPlan = {
  summary: "Probe the request pipeline.",
  phases: [
    { title: "Architecture", coverage_area_ids: ["architecture"], goals: ["Request flow"], minutes: 10 },
    { title: "Data", coverage_area_ids: ["data"], goals: ["Schema choices"], minutes: 15 },
  ],
  opening_question: "Walk me through src/server.ts.",
};

const interviewRow: InterviewRow = {
  id: INTERVIEW_ID,
  workspace_id: WORKSPACE_ID,
  status: "created",
  repository_commit_sha: SHA,
};

interface Setup {
  interview?: InterviewRow | null;
  planning?: PlanningState | null;
  storedPlan?: unknown;
  events?: VoiceEvent[];
  openai?: (req: Request) => Response | Promise<Response>;
  turnResult?: RecordResult;
  voiceResult?: RecordResult;
}

function at(offsetSeconds: number): string {
  return new Date(NOW.getTime() + offsetSeconds * 1000).toISOString();
}

function setup({
  interview = interviewRow,
  planning = "succeeded",
  storedPlan = plan,
  events = [],
  openai = () => Response.json({ value: "ek_test_123", expires_at: NOW.getTime() / 1000 + 60, session: {} }),
  turnResult = { status: "created", sequence: 3 },
  voiceResult = { status: "created", sequence: 7 },
}: Setup = {}) {
  const rlsClient = { rls: true } as unknown as SupabaseClient;
  const openaiRequests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const turns: TranscriptTurnRecord[] = [];
  const voiceEvents: VoiceEventRecord[] = [];
  const authenticate: Authenticate = (req) =>
    Promise.resolve(
      req.headers.get("Authorization") === "Bearer valid" ? { user: { id: userId } as User, supabase: rlsClient } : null,
    );
  const reader = (client: SupabaseClient): InterviewReader => {
    assert(client === rlsClient, "reads must use the caller's RLS client");
    return {
      getInterview: (id) => Promise.resolve(interview && interview.id === id ? interview : null),
      getPlanningState: () => Promise.resolve(planning),
    };
  };
  const store: InterviewStore = {
    getPlan: (id) => {
      assertEquals(id, INTERVIEW_ID);
      return Promise.resolve(storedPlan);
    },
    listVoiceEvents: () => Promise.resolve(events),
    getRepositoryContext: (workspaceId, sha) => {
      assertEquals([workspaceId, sha], [WORKSPACE_ID, SHA]);
      return Promise.resolve({
        repositoryFullName: "alice/demo",
        memory: [{ kind: "architecture_summary", content: "Express API." }],
      });
    },
    recordTranscriptTurn: (turn) => {
      turns.push(turn);
      return Promise.resolve(turnResult);
    },
    recordVoiceEvent: (event) => {
      voiceEvents.push(event);
      return Promise.resolve(voiceResult);
    },
  };
  const fakeFetch: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    openaiRequests.push({ url: req.url, headers: req.headers, body: await req.clone().json() });
    return openai(req);
  };
  const handler = createInterviewsHandler({
    webOrigin,
    authenticate,
    reader,
    store,
    realtime: createRealtimeClient({ apiKey: API_KEY, fetch: fakeFetch }),
    model: "gpt-realtime-2.1-mini",
    transcriptionModel: "gpt-4o-mini-transcribe",
    now: () => NOW,
  });
  return { handler, openaiRequests, turns, voiceEvents };
}

function post(path = `/interviews/${INTERVIEW_ID}/realtime/session`, auth = "Bearer valid", method = "POST") {
  return new Request(`http://localhost:54321/functions/v1${path}`, {
    method,
    headers: { Authorization: auth, Origin: webOrigin },
  });
}

async function expectError(res: Response, status: number, code: string) {
  assertEquals(res.status, status);
  const body = apiErrorSchema.parse(await res.json());
  assertEquals(body.code, code);
}

function captureLogs<T>(run: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (line: string) => lines.push(line);
  return run().then((result) => ({ result, lines })).finally(() => {
    console.error = original;
  });
}

Deno.test("rejects unauthenticated requests before touching OpenAI", async () => {
  const { handler, openaiRequests } = setup();
  await expectError(await handler(post(undefined, "Bearer nope")), 401, "unauthorized");
  assertEquals(openaiRequests.length, 0);
});

Deno.test("unknown, malformed, and other users' interviews are not found", async () => {
  const { handler } = setup({ interview: null });
  await expectError(await handler(post()), 404, "interview_not_found");
  await expectError(await handler(post("/interviews/not-a-uuid/realtime/session")), 404, "interview_not_found");
});

Deno.test("only POST on the session route is allowed", async () => {
  const { handler } = setup();
  const res = await handler(post(undefined, "Bearer valid", "GET"));
  await expectError(res, 405, "method_not_allowed");
  assertEquals(res.headers.get("allow"), "POST, OPTIONS");
  await expectError(await handler(post(`/interviews/${INTERVIEW_ID}`)), 404, "not_found");
});

Deno.test("rejects other origins", async () => {
  const { handler } = setup();
  const res = await handler(
    new Request(`http://localhost:54321/functions/v1/interviews/${INTERVIEW_ID}/realtime/session`, {
      method: "POST",
      headers: { Authorization: "Bearer valid", Origin: "https://evil.example" },
    }),
  );
  assertEquals(res.status, 403);
});

Deno.test("ended interviews are not active", async () => {
  for (const status of ["completed", "terminated", "failed"] as const) {
    const { handler, openaiRequests } = setup({ interview: { ...interviewRow, status } });
    await expectError(await handler(post()), 409, "interview_not_active");
    assertEquals(openaiRequests.length, 0);
  }
});

Deno.test("planning gate: preparing, failed, and missing plan", async () => {
  for (const planning of ["queued", "running", null] as const) {
    const { handler } = setup({ planning, storedPlan: {} });
    await expectError(await handler(post()), 409, "interview_preparing");
  }
  await expectError(await setup({ planning: "failed" }).handler(post()), 409, "interview_planning_failed");
  await expectError(
    await setup({ planning: "succeeded", storedPlan: {} }).handler(post()),
    409,
    "interview_planning_failed",
  );
});

Deno.test("refuses a credential once the 35-minute voice cap is used", async () => {
  const events: VoiceEvent[] = [
    { event_type: "connected", occurred_at: at(-3_000) },
    { event_type: "disconnected", occurred_at: at(-3_000 + VOICE_LIMIT_SECONDS) },
  ];
  const { handler, openaiRequests } = setup({ events });
  await expectError(await handler(post()), 409, "interview_not_active");
  assertEquals(openaiRequests.length, 0);
});

Deno.test("mints a credential with server-side instructions and tools", async () => {
  const events: VoiceEvent[] = [
    { event_type: "connected", occurred_at: at(-1_000) },
    { event_type: "disconnected", occurred_at: at(-400) },
  ];
  const { handler, openaiRequests } = setup({ events });
  const res = await handler(post());
  assertEquals(res.status, 201);
  assertEquals(res.headers.get("cache-control"), "no-store");
  assertEquals(res.headers.get("access-control-allow-origin"), webOrigin);
  const text = await res.clone().text();
  assert(!text.includes(API_KEY), "response leaks the API key");
  assert(![...res.headers.values()].some((v) => v.includes(API_KEY)), "headers leak the API key");
  assertEquals(realtimeSessionResponseSchema.parse(await res.json()), {
    client_secret: "ek_test_123",
    expires_at: "2026-10-05T12:01:00.000Z",
    model: "gpt-realtime-2.1-mini",
    remaining_voice_seconds: VOICE_LIMIT_SECONDS - 600,
  });

  assertEquals(openaiRequests.length, 1);
  const [{ url, headers, body }] = openaiRequests;
  assertEquals(url, "https://api.openai.com/v1/realtime/client_secrets");
  assertEquals(headers.get("authorization"), `Bearer ${API_KEY}`);
  const safetyId = headers.get("openai-safety-identifier") ?? "";
  assert(/^[0-9a-f]{64}$/.test(safetyId) && !safetyId.includes(userId), "safety id must be a hash");
  assertEquals(body.expires_after, { anchor: "created_at", seconds: CREDENTIAL_TTL_SECONDS });
  const session = body.session as Record<string, unknown>;
  assertEquals(session.type, "realtime");
  assertEquals(session.model, "gpt-realtime-2.1-mini");
  assertEquals(session.tool_choice, "auto");
  assertEquals(session.truncation, "auto");
  const audio = session.audio as { input: Record<string, Record<string, unknown>> };
  assertEquals(audio.input.transcription.model, "gpt-4o-mini-transcribe");
  assertEquals(audio.input.turn_detection.interrupt_response, true);
  const tools = session.tools as { name: string }[];
  assertEquals(tools.map((t) => t.name).sort(), [
    "advance_interview",
    "end_interview",
    "evaluate_answer",
    "get_file",
    "search_repository",
  ]);
  const instructions = session.instructions as string;
  assert(instructions.includes("<repository_context>") && instructions.includes("Express API."));
  assert(instructions.includes("10 minutes of voice time used"));
  assert(!instructions.includes(INTERVIEW_ID), "instructions must not carry database ids");
});

Deno.test("first session asks the opening question", async () => {
  const { handler, openaiRequests } = setup();
  assertEquals((await handler(post())).status, 201);
  const instructions = (openaiRequests[0].body.session as { instructions: string }).instructions;
  assert(instructions.includes(plan.opening_question));
});

Deno.test("OpenAI failures map to realtime_unavailable without leaking details", async () => {
  const failures: Setup["openai"][] = [
    () => new Response(`{"error":{"message":"bad key ${API_KEY}"}}`, { status: 401 }),
    () => new Response("upstream", { status: 503 }),
    () => Response.json({ unexpected: true }),
    () => Promise.reject(new TypeError("network down")),
  ];
  for (const openai of failures) {
    const { handler } = setup({ openai });
    const { result: res, lines } = await captureLogs(() => handler(post()));
    assertEquals(res.status, 502);
    const text = await res.clone().text();
    assert(!text.includes(API_KEY) && !text.includes("bad key"));
    await expectError(res, 502, "realtime_unavailable");
    assertEquals(lines.length, 1);
    assert(!lines[0].includes(API_KEY) && !lines[0].includes("bad key"));
    assertEquals(JSON.parse(lines[0]).interview_id, INTERVIEW_ID);
  }
});

// POST /interviews/:id/events ------------------------------------------------------

const EVENT_ID = "bbbbbbbb-0000-4000-8000-000000000001";

const turnEvent = {
  type: "transcript_turn",
  client_event_id: EVENT_ID,
  role: "user",
  content: " It uses Postgres. ",
  item_id: "item_1",
  occurred_at: NOW.toISOString(),
};

function postEvent(body: unknown, { id = INTERVIEW_ID, auth = "Bearer valid" } = {}) {
  return new Request(`http://localhost:54321/functions/v1/interviews/${id}/events`, {
    method: "POST",
    headers: { Authorization: auth, Origin: webOrigin, "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

Deno.test("events: rejects unauthenticated requests without writing", async () => {
  const { handler, turns } = setup();
  await expectError(await handler(postEvent(turnEvent, { auth: "Bearer nope" })), 401, "unauthorized");
  assertEquals(turns.length, 0);
});

Deno.test("events: unknown, malformed, and other users' interviews are not found", async () => {
  const { handler, turns } = setup({ interview: null });
  await expectError(await handler(postEvent(turnEvent)), 404, "interview_not_found");
  await expectError(await handler(postEvent(turnEvent, { id: "not-a-uuid" })), 404, "interview_not_found");
  assertEquals(turns.length, 0);
});

Deno.test("events: invalid bodies are rejected", async () => {
  const { handler, turns, voiceEvents } = setup();
  const bodies = [
    "{not json",
    { ...turnEvent, role: "system" },
    { ...turnEvent, content: "   " },
    { ...turnEvent, sequence: 1 },
    { type: "connected", client_event_id: EVENT_ID, occurred_at: NOW.toISOString(), sequence: 1 },
    { type: "tool_call", client_event_id: EVENT_ID, occurred_at: NOW.toISOString() },
  ];
  for (const body of bodies) {
    await expectError(await handler(postEvent(body)), 400, "invalid_request");
  }
  assertEquals([turns.length, voiceEvents.length], [0, 0]);
});

Deno.test("events: only POST is allowed", async () => {
  const { handler } = setup();
  const res = await handler(new Request(`http://localhost:54321/functions/v1/interviews/${INTERVIEW_ID}/events`, {
    method: "GET",
    headers: { Authorization: "Bearer valid", Origin: webOrigin },
  }));
  await expectError(res, 405, "method_not_allowed");
});

Deno.test("events: a new turn is stored and acknowledged with the server-assigned turn_sequence", async () => {
  const { handler, turns } = setup({ turnResult: { status: "created", sequence: 3 } });
  const res = await handler(postEvent({ ...turnEvent, interrupted: true }));
  assertEquals(res.status, 201);
  assertEquals(res.headers.get("access-control-allow-origin"), webOrigin);
  assertEquals(interviewEventAckSchema.parse(await res.json()), {
    type: "transcript_turn",
    status: "created",
    client_event_id: EVENT_ID,
    turn_sequence: 3,
  });
  assertEquals(turns, [{
    interviewId: INTERVIEW_ID,
    userId,
    clientEventId: EVENT_ID,
    role: "user",
    content: "It uses Postgres.",
    metadata: { item_id: "item_1", occurred_at: NOW.toISOString(), interrupted: true },
  }]);
});

Deno.test("events: a duplicate turn returns 200 with the stored sequence", async () => {
  const { handler } = setup({ turnResult: { status: "duplicate", sequence: 3 } });
  const res = await handler(postEvent(turnEvent));
  assertEquals(res.status, 200);
  const body = interviewEventAckSchema.parse(await res.json());
  assertEquals(body.status, "duplicate");
  assert(body.type === "transcript_turn" && body.turn_sequence === 3);
});

Deno.test("events: a reused event id with a different payload is a 409", async () => {
  const { handler } = setup({ turnResult: { status: "event_conflict", sequence: 3 } });
  await expectError(await handler(postEvent(turnEvent)), 409, "event_conflict");
});

Deno.test("events: turns are accepted after the interview has ended", async () => {
  for (const status of ["completed", "terminated", "failed"] as const) {
    const { handler, turns } = setup({ interview: { ...interviewRow, status } });
    assertEquals((await handler(postEvent(turnEvent))).status, 201);
    assertEquals(turns.length, 1);
  }
});

Deno.test("events: voice events get a server event_sequence and keep the client clock in the payload", async () => {
  const { handler, voiceEvents } = setup({ voiceResult: { status: "created", sequence: 7 } });
  const occurredAt = "2020-01-01T00:00:00.000Z";
  const res = await handler(postEvent({ type: "disconnected", client_event_id: EVENT_ID, occurred_at: occurredAt }));
  assertEquals(res.status, 201);
  const body = await res.json();
  assertEquals(interviewEventAckSchema.parse(body), {
    type: "disconnected",
    status: "created",
    client_event_id: EVENT_ID,
    event_sequence: 7,
  });
  assert(!("turn_sequence" in body), "voice acks never carry a turn sequence");
  assertEquals(voiceEvents, [{
    interviewId: INTERVIEW_ID,
    userId,
    clientEventId: EVENT_ID,
    eventType: "disconnected",
    payload: { client_occurred_at: occurredAt },
  }]);

  const dup = setup({ voiceResult: { status: "duplicate", sequence: 7 } });
  const again = await dup.handler(postEvent({ type: "connected", client_event_id: EVENT_ID, occurred_at: occurredAt }));
  assertEquals(again.status, 200);
  const conflict = setup({ voiceResult: { status: "event_conflict", sequence: 7 } });
  await expectError(
    await conflict.handler(postEvent({ type: "connected", client_event_id: EVENT_ID, occurred_at: occurredAt })),
    409,
    "event_conflict",
  );
});

Deno.test("voiceSecondsUsed sums connected time and closes open segments", () => {
  const ev = (event_type: VoiceEvent["event_type"], offset: number): VoiceEvent => ({
    event_type,
    occurred_at: at(offset),
  });
  assertEquals(voiceSecondsUsed([], NOW), 0);
  assertEquals(voiceSecondsUsed([ev("connected", -100), ev("disconnected", -40)], NOW), 60);
  // Reconnect without a disconnect closes the previous segment at the reconnect.
  assertEquals(voiceSecondsUsed([ev("connected", -100), ev("connected", -50), ev("disconnected", -20)], NOW), 80);
  // A trailing open segment runs until now.
  assertEquals(voiceSecondsUsed([ev("connected", -30)], NOW), 30);
  // Stray disconnects and bad timestamps are ignored.
  assertEquals(
    voiceSecondsUsed([ev("disconnected", -90), { event_type: "connected", occurred_at: "nope" }], NOW),
    0,
  );
});
