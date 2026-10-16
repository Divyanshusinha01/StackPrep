import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import {
  AI_USAGE_MAX_TOKENS_PER_EVENT,
  apiErrorSchema,
  deleteInterviewResponseSchema,
  endInterviewResponseSchema,
  integrityFrameResponseSchema,
  interviewEventAckSchema,
  type InterviewPlan,
  type InterviewReport,
  interviewReportResponseSchema,
  pauseInterviewResponseSchema,
  type PlanningState,
  realtimeSessionResponseSchema,
  resumeInterviewResponseSchema,
  VOICE_LIMIT_SECONDS,
} from "@stackprep/shared";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { AIUnavailableError, type StructuredRequest } from "../_shared/ai/provider.ts";
import { aiUsageCost } from "../_shared/ai-usage.ts";
import type { Authenticate } from "../_shared/auth.ts";
import { CREDENTIAL_TTL_SECONDS, createRealtimeClient } from "../_shared/realtime/openai-realtime.ts";
import { createOpenAIClients } from "../_shared/ai/clients.ts";
import { OpenAIKeyMissingError, OpenAIKeyUnusableError } from "../_shared/ai/credentials.ts";
import { createFakeAIProvider, createFakeEmbeddingProvider, FAKE_CREDENTIAL_ID } from "../_shared/testing.ts";
import { INTEGRITY_WARNING_MESSAGES } from "./integrity.ts";
import {
  createFakeGithub,
  createFakeIntegrityStore,
  createFakeJobQueue,
  createFakeReportJobs,
  createFakeToolStore,
} from "./testing.ts";
import type { InterviewStateSnapshot, TranscriptMessage } from "./tools/types.ts";
import {
  createInterviewsHandler,
  type DeleteResult,
  type EndResult,
  type InterviewReader,
  type InterviewRow,
  type InterviewStore,
  type PauseResult,
  type RecordResult,
  type ReportJob,
  type ResumeResult,
  type StoredReport,
  type TranscriptTurnRecord,
  type VoiceEvent,
  type VoiceEventRecord,
  voiceSecondsUsed,
} from "./handler.ts";
import type { VoiceSegmentEvent } from "./voice-usage.ts";

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
  report?: StoredReport | null;
  reportJob?: ReportJob | null;
  vision?: (request: StructuredRequest<unknown>) => unknown;
  messages?: TranscriptMessage[];
  state?: InterviewStateSnapshot | null;
  segmentEvents?: VoiceSegmentEvent[];
  pauseResult?: PauseResult;
  resumeResult?: ResumeResult;
  endResult?: EndResult;
  deleteResult?: DeleteResult;
  /** Thrown by the credential resolver instead of returning the caller's key. */
  keyError?: Error;
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
  report = null,
  reportJob = null,
  vision = () => ({ signal: false, kind: "none" }),
  messages = [],
  state = null,
  segmentEvents = [],
  pauseResult = { status: "paused", pauseCount: 1, pausedAt: NOW.toISOString(), disconnectedSequence: null },
  resumeResult = "resumed",
  endResult = { status: "completed", disconnectedSequence: null },
  deleteResult = { status: "deleted", disconnectedSequence: null },
  keyError,
}: Setup = {}) {
  const clock = { now: NOW };
  const rlsClient = { rls: true } as unknown as SupabaseClient;
  const openaiRequests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const turns: TranscriptTurnRecord[] = [];
  const voiceEvents: VoiceEventRecord[] = [];
  const pauseCalls: { op: "pause" | "resume" | "end" | "delete"; interviewId: string; userId: string }[] = [];
  const authenticate: Authenticate = (req) =>
    Promise.resolve(
      req.headers.get("Authorization") === "Bearer valid" ? { user: { id: userId } as User, supabase: rlsClient } : null,
    );
  const reader = (client: SupabaseClient): InterviewReader => {
    assert(client === rlsClient, "reads must use the caller's RLS client");
    return {
      getInterview: (id) => Promise.resolve(interview && interview.id === id ? interview : null),
      getPlanningState: () => Promise.resolve(planning),
      getReport: () => Promise.resolve(report),
      getReportJob: () => Promise.resolve(reportJob),
    };
  };
  const jobs = createFakeJobQueue();
  const reportJobs = createFakeReportJobs();
  const integrity = createFakeIntegrityStore(() => clock.now);
  const ai = createFakeAIProvider(vision);
  const toolStore = createFakeToolStore({ messages, state });
  const store: InterviewStore = {
    ...toolStore,
    listVoiceSegmentEvents: () => Promise.resolve(segmentEvents),
    reserveIntegrityCheck: (...args) => integrity.reserveIntegrityCheck(...args),
    recordIntegritySignal: (...args) => integrity.recordIntegritySignal(...args),
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
    pauseInterview: (interviewId, uid) => {
      pauseCalls.push({ op: "pause", interviewId, userId: uid });
      return Promise.resolve(pauseResult);
    },
    resumeInterview: (interviewId, uid) => {
      pauseCalls.push({ op: "resume", interviewId, userId: uid });
      return Promise.resolve(resumeResult);
    },
    endInterview: (interviewId, uid) => {
      pauseCalls.push({ op: "end", interviewId, userId: uid });
      return Promise.resolve(endResult);
    },
    deleteInterview: (interviewId, uid) => {
      pauseCalls.push({ op: "delete", interviewId, userId: uid });
      return Promise.resolve(deleteResult);
    },
  };
  const fakeFetch: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    openaiRequests.push({ url: req.url, headers: req.headers, body: await req.clone().json() });
    return openai(req);
  };
  const resolved: string[] = [];
  const marks: { userId: string; credentialId: string; status: string; code: string | null }[] = [];
  const openaiClients = createOpenAIClients(
    {
      resolve: (uid) => {
        resolved.push(uid);
        assertEquals(uid, userId, "the key must be resolved for the authenticated user");
        return keyError ? Promise.reject(keyError) : Promise.resolve({ apiKey: API_KEY, credentialId: FAKE_CREDENTIAL_ID });
      },
      markStatus: (uid, credentialId, status, code) => {
        marks.push({ userId: uid, credentialId, status, code });
        return Promise.resolve(true);
      },
    },
    {
      ai: () => ai,
      embeddings: () => createFakeEmbeddingProvider(),
      realtime: (apiKey) => createRealtimeClient({ apiKey, fetch: fakeFetch }),
    },
  );
  const handler = createInterviewsHandler({
    webOrigin,
    authenticate,
    reader,
    store,
    openai: openaiClients,
    model: "gpt-realtime-2.1-mini",
    transcriptionModel: "gpt-live-transcribe",
    github: createFakeGithub({}),
    evaluationModel: "gpt-eval",
    visionModel: "gpt-vision",
    jobs,
    reportJobs,
    now: () => clock.now,
  });
  return {
    handler,
    openaiRequests,
    turns,
    voiceEvents,
    pauseCalls,
    jobs,
    reportJobs,
    integrity,
    ai,
    clock,
    usage: toolStore.usage,
    resolved,
    marks,
  };
}

type OpenAIRequest = ReturnType<typeof setup>["openaiRequests"][number];

function sessionRequest(requests: OpenAIRequest[], type: "realtime" | "transcription"): OpenAIRequest {
  const found = requests.filter((r) => (r.body.session as { type: string }).type === type);
  assertEquals(found.length, 1);
  return found[0];
}

function voiceRequest(requests: OpenAIRequest[]): OpenAIRequest {
  return sessionRequest(requests, "realtime");
}

/** Answers the voice mint with `voice` and the transcription mint with `transcription`. */
function bySessionType(
  voice: () => Response | Promise<Response>,
  transcription: () => Response | Promise<Response>,
): Setup["openai"] {
  return async (req) => {
    const body = await req.clone().json() as { session: { type: string } };
    return body.session.type === "transcription" ? transcription() : voice();
  };
}

function voiceInstructions(requests: OpenAIRequest[]): string {
  return (voiceRequest(requests).body.session as { instructions: string }).instructions;
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
  await expectError(await handler(post(`/interviews/${INTERVIEW_ID}/unknown`)), 404, "not_found");
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
    transcription: {
      client_secret: "ek_test_123",
      expires_at: "2026-10-05T12:01:00.000Z",
      model: "gpt-live-transcribe",
    },
    remaining_voice_seconds: VOICE_LIMIT_SECONDS - 600,
    resume: { last_turn_sequence: 0, current_question: null },
  });

  assertEquals(openaiRequests.length, 2);
  for (const { url, headers, body } of openaiRequests) {
    assertEquals(url, "https://api.openai.com/v1/realtime/client_secrets");
    assertEquals(headers.get("authorization"), `Bearer ${API_KEY}`);
    const safetyId = headers.get("openai-safety-identifier") ?? "";
    assert(/^[0-9a-f]{64}$/.test(safetyId) && !safetyId.includes(userId), "safety id must be a hash");
    assertEquals(body.expires_after, { anchor: "created_at", seconds: CREDENTIAL_TTL_SECONDS });
  }
  const session = voiceRequest(openaiRequests).body.session as Record<string, unknown>;
  assertEquals(session.model, "gpt-realtime-2.1-mini");
  assertEquals(session.tool_choice, "auto");
  assertEquals(session.truncation, "auto");
  const audio = session.audio as { input: Record<string, Record<string, unknown>>; output: Record<string, unknown> };
  assertEquals("transcription" in audio.input, false, "the voice session must not transcribe the candidate");
  assertEquals(audio.input.noise_reduction, { type: "near_field" });
  assertEquals(audio.input.turn_detection, {
    type: "server_vad",
    silence_duration_ms: 700,
    create_response: true,
    interrupt_response: true,
  });
  assertEquals(audio.output, { voice: "marin", speed: 1.05 });

  const transcription = sessionRequest(openaiRequests, "transcription").body.session as Record<string, unknown>;
  assertEquals(transcription, {
    type: "transcription",
    audio: {
      input: {
        noise_reduction: { type: "near_field" },
        transcription: { model: "gpt-live-transcribe" },
        turn_detection: null,
      },
    },
  });
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

Deno.test("first session asks the opening question and has no resume point", async () => {
  const { handler, openaiRequests } = setup();
  const res = await handler(post());
  assertEquals(res.status, 201);
  assertEquals(realtimeSessionResponseSchema.parse(await res.json()).resume, null);
  const instructions = voiceInstructions(openaiRequests);
  assert(instructions.includes(plan.opening_question));
  assert(!instructions.includes("<recap>"));
});

const resumeMessages: TranscriptMessage[] = [
  { id: "m1", sequence: 1, role: "ai", content: "Walk me through src/server.ts." },
  { id: "m2", sequence: 2, role: "user", content: "It boots Express." },
  { id: "m3", sequence: 3, role: "ai", content: "How do you validate sessions?" },
];

const coverageState: InterviewStateSnapshot = {
  coverageMap: {
    areas: [
      { id: "architecture", name: "Architecture", priority: "high", rationale: "r", topics: ["flow"], repo_evidence: [], status: "covered" },
      { id: "data", name: "Data layer", priority: "medium", rationale: "r", topics: ["schema"], repo_evidence: [], status: "partial" },
      { id: "testing", name: "Testing", priority: "low", rationale: "r", topics: ["unit"], repo_evidence: [], status: "not_started" },
    ],
  },
  plan,
  strategy: {},
  version: 3,
};

Deno.test("a reconnected session gets a compact recap and its resume point", async () => {
  const events: VoiceEvent[] = [
    { event_type: "connected", occurred_at: at(-900) },
    { event_type: "disconnected", occurred_at: at(-300) },
  ];
  const { handler, openaiRequests } = setup({ events, messages: resumeMessages, state: coverageState });
  const res = await handler(post());
  assertEquals(res.status, 201);
  assertEquals(realtimeSessionResponseSchema.parse(await res.json()).resume, {
    last_turn_sequence: 3,
    current_question: "How do you validate sessions?",
  });
  const instructions = voiceInstructions(openaiRequests);
  const recap = instructions.slice(instructions.indexOf("<recap>"));
  assert(recap.includes("Architecture (covered); Data layer (partly covered)"));
  assert(!recap.includes("Testing"));
  assert(recap.includes("Current question: How do you validate sessions?"));
  assert(recap.includes("Candidate's answer: not received"));
  assert(instructions.includes("Ask the current question again"));
  assert(!instructions.includes("It boots Express."), "earlier turns are summarized, not replayed");
  assert(!instructions.includes("Start now"), "a resumed session does not restart the interview");
});

Deno.test("a reconnect after a saved answer tells the interviewer it was received", async () => {
  const messages: TranscriptMessage[] = [...resumeMessages, { id: "m4", sequence: 4, role: "user", content: "With signed JWTs." }];
  const events: VoiceEvent[] = [{ event_type: "connected", occurred_at: at(-120) }, { event_type: "disconnected", occurred_at: at(-60) }];
  const { handler, openaiRequests } = setup({ events, messages, state: coverageState });
  const body = realtimeSessionResponseSchema.parse(await (await handler(post())).json());
  assertEquals(body.resume?.last_turn_sequence, 4);
  const instructions = voiceInstructions(openaiRequests);
  assert(instructions.includes(`Candidate's answer: received: "With signed JWTs."`));
  assert(instructions.includes("may have been cut off"));
});

const KEY_REJECTED = () => new Response(`{"error":{"message":"bad key ${API_KEY}","code":"invalid_api_key"}}`, { status: 401 });

/** Failures that say nothing about the key. */
const TRANSIENT_FAILURES: (() => Response | Promise<Response>)[] = [
  () => new Response("upstream", { status: 503 }),
  () => Response.json({ unexpected: true }),
  () => Promise.reject(new TypeError("network down")),
];

const OPENAI_FAILURES = [KEY_REJECTED, ...TRANSIENT_FAILURES];

const mintedSecret = () => Response.json({ value: "ek_test_123", expires_at: NOW.getTime() / 1000 + 60, session: {} });

Deno.test("a missing or unusable key is reported before any mint, with the setup code", async () => {
  const cases: [Error, number, string][] = [
    [new OpenAIKeyMissingError(), 409, "openai_key_required"],
    [new OpenAIKeyUnusableError("invalid"), 409, "openai_key_invalid"],
    [new OpenAIKeyUnusableError("permission_denied"), 409, "openai_key_permission_denied"],
    [new OpenAIKeyUnusableError("quota_exhausted"), 409, "openai_quota_exhausted"],
  ];
  for (const [keyError, status, code] of cases) {
    const { handler, openaiRequests, resolved } = setup({ keyError });
    const { result: res } = await captureLogs(() => handler(post()));
    await expectError(res, status, code);
    assertEquals(openaiRequests, []);
    assertEquals(resolved, [userId]);
  }
});

Deno.test("a voice mint rejected for the key marks it invalid and returns openai_key_invalid without leaking it", async () => {
  const { handler, marks } = setup({ openai: KEY_REJECTED });
  const { result: res, lines } = await captureLogs(() => handler(post()));
  const text = await res.clone().text();
  assert(!text.includes(API_KEY) && !text.includes("bad key"));
  await expectError(res, 409, "openai_key_invalid");
  assert(marks.some((m) => m.status === "invalid" && m.credentialId === FAKE_CREDENTIAL_ID && m.userId === userId));
  assert(!lines.join("\n").includes(API_KEY));
});

Deno.test("an OpenAI rate limit on the voice mint returns openai_rate_limited with Retry-After", async () => {
  const limited = () => new Response(`{"error":{"code":"rate_limit_exceeded"}}`, { status: 429, headers: { "retry-after": "12" } });
  const { handler, marks } = setup({ openai: limited });
  const res = await handler(post());
  assertEquals(res.headers.get("retry-after"), "12");
  await expectError(res, 429, "openai_rate_limited");
  assertEquals(marks, []);
});

Deno.test("OpenAI failures map to realtime_unavailable without leaking details", async () => {
  for (const fail of TRANSIENT_FAILURES) {
    // The voice mint decides the outcome whether or not the transcription mint succeeds.
    for (const openai of [fail, bySessionType(fail, mintedSecret)]) {
      const { handler } = setup({ openai });
      const { result: res, lines } = await captureLogs(() => handler(post()));
      assertEquals(res.status, 502);
      const text = await res.clone().text();
      assert(!text.includes(API_KEY) && !text.includes("bad key"));
      await expectError(res, 502, "realtime_unavailable");
      assertEquals(lines.length, 1);
      assert(!lines[0].includes(API_KEY) && !lines[0].includes("bad key"));
      assertEquals(JSON.parse(lines[0]).event, "realtime_session_failed");
      assertEquals(JSON.parse(lines[0]).interview_id, INTERVIEW_ID);
    }
  }
});

Deno.test("a failed transcription mint still starts the voice session, without a transcription credential", async () => {
  for (const fail of OPENAI_FAILURES) {
    const { handler } = setup({ openai: bySessionType(mintedSecret, fail) });
    const { result: res, lines } = await captureLogs(() => handler(post()));
    assertEquals(res.status, 201);
    const text = await res.clone().text();
    assert(!text.includes(API_KEY) && !text.includes("bad key"));
    const body = realtimeSessionResponseSchema.parse(await res.json());
    assertEquals(body.client_secret, "ek_test_123");
    assertEquals(body.transcription, null);
    assertEquals(lines.length, 1);
    assert(!lines[0].includes(API_KEY) && !lines[0].includes("bad key"));
    assertEquals(JSON.parse(lines[0]).event, "realtime_transcription_unavailable");
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

Deno.test("events: only POST (record) and GET (stream) are allowed", async () => {
  const { handler } = setup();
  const res = await handler(new Request(`http://localhost:54321/functions/v1/interviews/${INTERVIEW_ID}/events`, {
    method: "DELETE",
    headers: { Authorization: "Bearer valid", Origin: webOrigin },
  }));
  await expectError(res, 405, "method_not_allowed");
  assertEquals(res.headers.get("allow"), "POST, GET, OPTIONS");
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

// Voice usage ----------------------------------------------------------------------------------

const CONNECTED_ID = "eeeeeeee-0000-4000-8000-000000000001";
const USAGE_EVENT_ID = "bbbbbbbb-0000-4000-8000-000000000009";

const usageEvent = {
  type: "voice_usage",
  client_event_id: USAGE_EVENT_ID,
  response_id: "resp_1",
  input_tokens: 1_200,
  cached_input_tokens: 5_000,
  output_tokens: 80,
  audio_input_tokens: 2_000_000,
  audio_cached_input_tokens: 0,
  audio_output_tokens: 900,
  occurred_at: NOW.toISOString(),
};

Deno.test("events: a disconnect writes duration estimates for the segment it closes", async () => {
  const segmentEvents: VoiceSegmentEvent[] = [
    { id: CONNECTED_ID, sequence: 6, event_type: "connected", occurred_at: at(-120) },
    { id: "eeeeeeee-0000-4000-8000-000000000002", sequence: 7, event_type: "disconnected", occurred_at: at(0) },
  ];
  const { handler, usage } = setup({ segmentEvents, voiceResult: { status: "created", sequence: 7 } });
  const event = { type: "disconnected", client_event_id: EVENT_ID, occurred_at: NOW.toISOString() };
  assertEquals((await handler(postEvent(event))).status, 201);
  assertEquals(usage.map(({ idempotencyKey: _, ...u }) => u), [
    {
      userId,
      workspaceId: WORKSPACE_ID,
      interviewId: INTERVIEW_ID,
      task: "voice",
      source: "duration_estimate",
      audioSeconds: 120,
      voiceSegmentEventId: CONNECTED_ID,
      model: "gpt-realtime-2.1-mini",
      tokens: { audio_input_tokens: 1_200, audio_output_tokens: 1_200 },
    },
    {
      userId,
      workspaceId: WORKSPACE_ID,
      interviewId: INTERVIEW_ID,
      task: "voice",
      source: "duration_estimate",
      audioSeconds: 120,
      voiceSegmentEventId: CONNECTED_ID,
      model: "gpt-live-transcribe",
    },
  ]);
  assertAlmostEquals(aiUsageCost(usage[1])!, 0.034, 1e-12);

  // Processing the same close again (a retried disconnect) estimates nothing new.
  await handler(postEvent(event));
  assertEquals(usage.length, 2);
});

Deno.test("events: pause and resume never write usage", async () => {
  const segmentEvents: VoiceSegmentEvent[] = [{ id: CONNECTED_ID, sequence: 6, event_type: "connected", occurred_at: at(-120) }];
  const { handler, usage } = setup({ segmentEvents, voiceResult: { status: "created", sequence: 7 } });
  await handler(postEvent({ type: "pause", reason: "network", client_event_id: EVENT_ID, occurred_at: NOW.toISOString() }));
  assertEquals(usage, []);
});

Deno.test("events: relayed voice usage is stored as client-reported for the open segment, clamped", async () => {
  const segmentEvents: VoiceSegmentEvent[] = [{ id: CONNECTED_ID, sequence: 6, event_type: "connected", occurred_at: at(-60) }];
  const { handler, usage, voiceEvents } = setup({ segmentEvents });
  const res = await handler(postEvent(usageEvent));
  assertEquals(res.status, 201);
  assertEquals(interviewEventAckSchema.parse(await res.json()), {
    type: "voice_usage",
    status: "created",
    client_event_id: USAGE_EVENT_ID,
  });
  assertEquals(voiceEvents, [], "usage is not an interview event");
  assertEquals(usage, [{
    userId,
    workspaceId: WORKSPACE_ID,
    interviewId: INTERVIEW_ID,
    task: "voice",
    model: "gpt-realtime-2.1-mini",
    source: "client_reported",
    tokens: {
      input_tokens: 1_200,
      cached_input_tokens: 1_200,
      output_tokens: 80,
      audio_input_tokens: AI_USAGE_MAX_TOKENS_PER_EVENT,
      audio_cached_input_tokens: 0,
      audio_output_tokens: 900,
    },
    voiceSegmentEventId: CONNECTED_ID,
    idempotencyKey: `voice_usage:${INTERVIEW_ID}:${USAGE_EVENT_ID}`,
  }]);

  const again = await handler(postEvent(usageEvent));
  assertEquals(again.status, 200);
  assertEquals(interviewEventAckSchema.parse(await again.json()).status, "duplicate");
  assertEquals(usage.length, 1);
});

Deno.test("events: relayed voice usage without an open segment is rejected", async () => {
  for (const segmentEvents of [
    [],
    [
      { id: CONNECTED_ID, sequence: 6, event_type: "connected", occurred_at: at(-60) },
      { id: "eeeeeeee-0000-4000-8000-000000000002", sequence: 7, event_type: "disconnected", occurred_at: at(-1) },
    ],
  ] as VoiceSegmentEvent[][]) {
    const { handler, usage } = setup({ segmentEvents });
    await expectError(await handler(postEvent(usageEvent)), 409, "voice_not_connected");
    assertEquals(usage, []);
  }
});

Deno.test("events: malformed voice usage is rejected", async () => {
  const segmentEvents: VoiceSegmentEvent[] = [{ id: CONNECTED_ID, sequence: 6, event_type: "connected", occurred_at: at(-60) }];
  const { handler, usage } = setup({ segmentEvents });
  for (const body of [
    { ...usageEvent, input_tokens: -1 },
    { ...usageEvent, output_tokens: 1.5 },
    { ...usageEvent, response_id: "" },
    { ...usageEvent, estimated_cost_usd: 0 },
  ]) {
    await expectError(await handler(postEvent(body)), 400, "invalid_request");
  }
  assertEquals(usage, []);
});

// GET /interviews/:id/report and POST /interviews/:id/report/retry ---------------------------------

const completed: InterviewRow = { ...interviewRow, status: "completed" };

const storedReport: InterviewReport = {
  executive_summary: "Strong on architecture, shallow on data.",
  categories: [{ name: "Architecture", rating: "proficient", narrative: "Traced the request flow." }],
  strengths: ["Request lifecycle"],
  gaps: ["Migrations"],
  interview_evidence: [{ category: "Architecture", observation: "Explained src/server.ts." }],
  repository_evidence: [{ path: "src/server.ts", note: "Discussed routing." }],
  areas_to_improve: ["Migration rollback"],
  struggled_questions: [],
};

function reportRequest(path = "report", method = "GET", auth = "Bearer valid") {
  return new Request(`http://localhost:54321/functions/v1/interviews/${INTERVIEW_ID}/${path}`, {
    method,
    headers: { Authorization: auth, Origin: webOrigin },
  });
}

async function reportBody(res: Response, status = 200) {
  assertEquals(res.status, status);
  return interviewReportResponseSchema.parse(await res.json());
}

Deno.test("report: auth, ownership, and completion are checked first", async () => {
  await expectError(await setup({ interview: completed }).handler(reportRequest("report", "GET", "Bearer nope")), 401, "unauthorized");
  await expectError(await setup({ interview: null }).handler(reportRequest()), 404, "interview_not_found");
  for (const status of ["created", "in_progress", "terminated"] as const) {
    const { handler } = setup({ interview: { ...interviewRow, status } });
    await expectError(await handler(reportRequest()), 409, "interview_not_completed");
    await expectError(await handler(reportRequest("report/retry", "POST")), 409, "interview_not_completed");
  }
  const res = await setup({ interview: completed }).handler(reportRequest("report", "POST"));
  await expectError(res, 405, "method_not_allowed");
  assertEquals(res.headers.get("allow"), "GET, OPTIONS");
});

Deno.test("report: pending while the job is queued or running", async () => {
  for (const status of ["queued", "running"] as const) {
    const { handler } = setup({ interview: completed, reportJob: { status, error_code: null } });
    assertEquals(await reportBody(await handler(reportRequest())), { status: "pending" });
  }
});

Deno.test("report: ready returns the validated report", async () => {
  const generated_at = "2026-10-05T12:00:00.123456+00:00";
  const { handler } = setup({
    interview: completed,
    report: { content: storedReport, generated_at },
    reportJob: { status: "succeeded", error_code: null },
  });
  assertEquals(await reportBody(await handler(reportRequest())), { status: "ready", report: storedReport, generated_at });
});

Deno.test("report: failures carry a fixed code; unknown codes and invalid content are internal_error", async () => {
  const failed = setup({ interview: completed, reportJob: { status: "failed", error_code: "ai_unavailable" } });
  assertEquals(await reportBody(await failed.handler(reportRequest())), { status: "failed", error_code: "ai_unavailable" });

  const odd = setup({ interview: completed, reportJob: { status: "failed", error_code: "db password=x" } });
  assertEquals(await reportBody(await odd.handler(reportRequest())), { status: "failed", error_code: "internal_error" });

  const missing = setup({ interview: completed });
  assertEquals(await reportBody(await missing.handler(reportRequest())), { status: "failed", error_code: "enqueue_failed" });

  const invalid = setup({ interview: completed, report: { content: { score: 5 }, generated_at: NOW.toISOString() } });
  const { result } = await captureLogs(() => invalid.handler(reportRequest()));
  assertEquals(await reportBody(result), { status: "failed", error_code: "internal_error" });
});

Deno.test("report retry: only failed reports can be retried", async () => {
  const pending = setup({ interview: completed, reportJob: { status: "running", error_code: null } });
  await expectError(await pending.handler(reportRequest("report/retry", "POST")), 409, "report_not_retryable");
  const ready = setup({
    interview: completed,
    report: { content: storedReport, generated_at: NOW.toISOString() },
    reportJob: { status: "succeeded", error_code: null },
  });
  await expectError(await ready.handler(reportRequest("report/retry", "POST")), 409, "report_not_retryable");
  assertEquals([pending.jobs.sent.length, ready.jobs.sent.length], [0, 0]);
});

Deno.test("report retry: a failed report is queued again", async () => {
  const { handler, jobs, reportJobs } = setup({ interview: completed, reportJob: { status: "failed", error_code: "ai_unavailable" } });
  assertEquals(await reportBody(await handler(reportRequest("report/retry", "POST")), 202), { status: "pending" });
  assertEquals(reportJobs.requests, [INTERVIEW_ID]);
  assertEquals(jobs.sent, [{
    name: "interview.report.requested",
    payload: { interview_id: INTERVIEW_ID, workspace_id: WORKSPACE_ID, job_id: "job-1" },
  }]);
});

Deno.test("report retry: a retry that cannot be queued reports the current state", async () => {
  const skipped = setup({ interview: completed, reportJob: { status: "failed", error_code: "ai_unavailable" } });
  skipped.reportJobs.skip = true;
  const body = await reportBody(await skipped.handler(reportRequest("report/retry", "POST")));
  assertEquals(body, { status: "failed", error_code: "ai_unavailable" });
  assertEquals(skipped.jobs.sent.length, 0);

  const down = setup({ interview: completed });
  down.jobs.fail = new Error("inngest down");
  const { result, lines } = await captureLogs(() => down.handler(reportRequest("report/retry", "POST")));
  assertEquals((await reportBody(result)).status, "failed");
  assertEquals(down.reportJobs.failures, [{ jobId: "job-1", code: "enqueue_failed" }]);
  assert(!lines.join("\n").includes("inngest down"), "logs carry codes, not raw errors");
});

Deno.test("report retry: without a usable key nothing is queued and the setup code is returned", async () => {
  const cases: [Error, string][] = [
    [new OpenAIKeyMissingError(), "openai_key_required"],
    [new OpenAIKeyUnusableError("quota_exhausted"), "openai_quota_exhausted"],
  ];
  for (const [keyError, code] of cases) {
    const { handler, jobs, reportJobs } = setup({
      interview: completed,
      reportJob: { status: "failed", error_code: "openai_key_unavailable" },
      keyError,
    });
    const { result } = await captureLogs(() => handler(reportRequest("report/retry", "POST")));
    await expectError(result, 409, code);
    assertEquals([jobs.sent.length, reportJobs.requests.length], [0, 0]);
  }
});

Deno.test("events: pause keeps its reason and resume is acknowledged like other voice events", async () => {
  const { handler, voiceEvents } = setup({ voiceResult: { status: "created", sequence: 11 } });
  const occurredAt = NOW.toISOString();
  const paused = await handler(postEvent({ type: "pause", reason: "camera", client_event_id: EVENT_ID, occurred_at: occurredAt }));
  assertEquals(paused.status, 201);
  assertEquals(interviewEventAckSchema.parse(await paused.json()), {
    type: "pause",
    status: "created",
    client_event_id: EVENT_ID,
    event_sequence: 11,
  });
  const RESUME_ID = "bbbbbbbb-0000-4000-8000-000000000002";
  assertEquals((await handler(postEvent({ type: "resume", client_event_id: RESUME_ID, occurred_at: occurredAt }))).status, 201);
  assertEquals(voiceEvents.map((e) => [e.eventType, e.payload]), [
    ["pause", { client_occurred_at: occurredAt, reason: "camera" }],
    ["resume", { client_occurred_at: occurredAt }],
  ]);
  await expectError(
    await handler(postEvent({ type: "pause", reason: "bored", client_event_id: EVENT_ID, occurred_at: occurredAt })),
    400,
    "invalid_request",
  );
});

// POST /interviews/:id/integrity/frames ---------------------------------------------------

const FRAME = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==";
const inProgress: InterviewRow = { ...interviewRow, status: "in_progress" };

function postFrame(body: unknown, { auth = "Bearer valid", id = INTERVIEW_ID, headers = {} as Record<string, string> } = {}) {
  return new Request(`http://localhost:54321/functions/v1/interviews/${id}/integrity/frames`, {
    method: "POST",
    headers: { Authorization: auth, Origin: webOrigin, "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function frameBody(res: Response) {
  assertEquals(res.status, 200);
  return integrityFrameResponseSchema.parse(await res.json());
}

function captureAllLogs<T>(run: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const [log, error] = [console.log, console.error];
  console.log = (line: string) => lines.push(line);
  console.error = (line: string) => lines.push(line);
  return run().then((result) => ({ result, lines })).finally(() => {
    console.log = log;
    console.error = error;
  });
}

function signals(...kinds: string[]) {
  let i = 0;
  return () => {
    const kind = kinds[i++] ?? "none";
    return { signal: kind !== "none", kind };
  };
}

Deno.test("frames: auth, ownership, method, and body are checked before reserving", async () => {
  const { handler, integrity, ai } = setup({ interview: inProgress });
  await expectError(await handler(postFrame({ image: FRAME }, { auth: "Bearer nope" })), 401, "unauthorized");
  await expectError(await handler(postFrame({ image: FRAME }, { id: "nope" })), 404, "interview_not_found");
  await expectError(await setup({ interview: null }).handler(postFrame({ image: FRAME })), 404, "interview_not_found");
  for (const body of ["{bad", { image: "data:image/png;base64,iVBORw0KGgo=" }, { image: FRAME, extra: 1 }, {}]) {
    await expectError(await handler(postFrame(body)), 400, "invalid_request");
  }
  await expectError(
    await handler(postFrame({ image: FRAME }, { headers: { "Content-Length": "999999" } })),
    400,
    "invalid_request",
  );
  const get = await handler(new Request(`http://localhost:54321/functions/v1/interviews/${INTERVIEW_ID}/integrity/frames`, {
    method: "GET",
    headers: { Authorization: "Bearer valid", Origin: webOrigin },
  }));
  await expectError(get, 405, "method_not_allowed");
  assertEquals([integrity.checks.size, ai.calls.length], [0, 0]);
});

Deno.test("frames: a clear frame is analyzed at low detail with the vision model and resolved", async () => {
  const { handler, integrity, ai, usage } = setup({ interview: inProgress });
  assertEquals(await frameBody(await handler(postFrame({ image: FRAME }))), { status: "ok" });
  assertEquals(ai.calls.length, 1);
  assertEquals([ai.calls[0].model, ai.calls[0].images], ["gpt-vision", [FRAME]]);
  assertEquals([...integrity.checks.values()], [{ status: "clear", warningNumber: null }]);
  assertEquals(integrity.warnings, []);
  assertEquals(usage, [{
    userId,
    workspaceId: WORKSPACE_ID,
    interviewId: INTERVIEW_ID,
    task: "vision",
    model: "gpt-vision",
    source: "provider",
    tokens: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 50 },
    idempotencyKey: `vision:${[...integrity.checks.keys()][0]}`,
    openaiCredentialId: FAKE_CREDENTIAL_ID,
  }]);
  assertAlmostEquals(aiUsageCost({ ...usage[0], model: "gpt-5.6-luna" })!, (100 * 0.2 + 50 * 1.2) / 1_000_000, 1e-15);
});

Deno.test("frames: a vision failure records no usage", async () => {
  const { handler, usage } = setup({ interview: inProgress, vision: () => new AIUnavailableError(503) });
  await captureAllLogs(() => handler(postFrame({ image: FRAME })));
  assertEquals(usage, []);
});

Deno.test("frames: signals 1 and 2 warn, the third terminates", async () => {
  const { handler, integrity, clock } = setup({ interview: inProgress, vision: signals("looking_away", "device_or_notes", "other_person") });
  const first = await frameBody(await handler(postFrame({ image: FRAME })));
  assertEquals(first, { status: "warning", warning_number: 1, message: INTEGRITY_WARNING_MESSAGES.looking_away });
  clock.now = new Date(clock.now.getTime() + 10_000);
  const second = await frameBody(await handler(postFrame({ image: FRAME })));
  assertEquals(second, { status: "warning", warning_number: 2, message: INTEGRITY_WARNING_MESSAGES.device_or_notes });
  clock.now = new Date(clock.now.getTime() + 10_000);
  const third = await frameBody(await handler(postFrame({ image: FRAME })));
  assert(third.status === "terminated" && third.warning_number === 3);
  assertEquals(integrity.status, "terminated");
  assertEquals(integrity.warnings.map((w) => [w.kind, w.number]), [["looking_away", 1], ["device_or_notes", 2], ["other_person", 3]]);
  clock.now = new Date(clock.now.getTime() + 10_000);
  await expectError(await handler(postFrame({ image: FRAME })), 409, "interview_not_active");
});

Deno.test("frames: more than one frame per 10 seconds is rate limited without calling the model", async () => {
  const { handler, ai, clock } = setup({ interview: inProgress });
  await frameBody(await handler(postFrame({ image: FRAME })));
  clock.now = new Date(clock.now.getTime() + 9_000);
  const limited = await handler(postFrame({ image: FRAME }));
  assertEquals(limited.headers.get("retry-after"), "10");
  await expectError(limited, 429, "rate_limited");
  assertEquals(ai.calls.length, 1);
  clock.now = new Date(clock.now.getTime() + 1_000);
  await frameBody(await handler(postFrame({ image: FRAME })));
  assertEquals(ai.calls.length, 2);
});

Deno.test("frames: two frames at once lead to one accepted check", async () => {
  const { handler, ai, integrity } = setup({ interview: inProgress, vision: signals("looking_away", "looking_away") });
  const statuses = (await Promise.all([handler(postFrame({ image: FRAME })), handler(postFrame({ image: FRAME }))]))
    .map((res) => res.status)
    .sort();
  assertEquals(statuses, [200, 429]);
  assertEquals([ai.calls.length, integrity.checks.size, integrity.warnings.length], [1, 1, 1]);
});

Deno.test("frames: refused while paused or disconnected, and when the interview is not active", async () => {
  for (const voice of ["pause", "disconnected"] as const) {
    const { handler, integrity, ai } = setup({ interview: inProgress });
    integrity.voice = voice;
    await expectError(await handler(postFrame({ image: FRAME })), 409, "interview_interrupted");
    assertEquals([integrity.checks.size, ai.calls.length], [0, 0]);
  }
  const ended = setup({ interview: inProgress });
  ended.integrity.status = "completed";
  await expectError(await ended.handler(postFrame({ image: FRAME })), 409, "interview_not_active");
});

Deno.test("frames: a vision failure fails open but still counts toward the rate limit", async () => {
  const { handler, integrity, clock } = setup({ interview: inProgress, vision: () => new AIUnavailableError(503) });
  const { result, lines } = await captureAllLogs(() => handler(postFrame({ image: FRAME })));
  assertEquals(await frameBody(result), { status: "ok" });
  assertEquals([...integrity.checks.values()], [{ status: "clear", warningNumber: null }]);
  assert(lines.some((line) => JSON.parse(line).event === "integrity_check_failed"));
  clock.now = new Date(clock.now.getTime() + 5_000);
  await expectError(await handler(postFrame({ image: FRAME })), 429, "rate_limited");
});

Deno.test("frames: a missing key records no signal, so the candidate is never penalized", async () => {
  const { handler, integrity, ai } = setup({ interview: inProgress, keyError: new OpenAIKeyMissingError() });
  const { result, lines } = await captureAllLogs(() => handler(postFrame({ image: FRAME })));
  assertEquals(await frameBody(result), { status: "ok" });
  assertEquals([...integrity.checks.values()], [{ status: "clear", warningNumber: null }]);
  assertEquals(ai.calls.length, 0);
  const failed = lines.map((line) => JSON.parse(line)).find((e) => e.event === "integrity_check_failed");
  assertEquals(failed?.reason, "openai_key_unavailable");
});

Deno.test("frames: usage is attributed to the credential that paid for it", async () => {
  const { handler, usage } = setup({ interview: inProgress });
  await captureAllLogs(() => handler(postFrame({ image: FRAME })));
  assertEquals(usage.map((u) => [u.task, u.openaiCredentialId]), [["vision", FAKE_CREDENTIAL_ID]]);
});

Deno.test("frames: an interview that ends while the frame is analyzed records nothing", async () => {
  const ref: { integrity?: ReturnType<typeof createFakeIntegrityStore> } = {};
  const { handler, integrity } = setup({
    interview: inProgress,
    vision: () => {
      ref.integrity!.status = "completed";
      return { signal: true, kind: "looking_away" };
    },
  });
  ref.integrity = integrity;
  await expectError(await handler(postFrame({ image: FRAME })), 409, "interview_not_active");
  assertEquals(integrity.warnings, []);
});

Deno.test("frames: the image is never logged or stored", async () => {
  const { handler, integrity } = setup({ interview: inProgress, vision: signals("face_absent") });
  const { result, lines } = await captureAllLogs(() => handler(postFrame({ image: FRAME })));
  assertEquals((await frameBody(result)).status, "warning");
  assert(lines.length > 0);
  for (const line of lines) {
    assert(!line.includes("base64") && !line.includes(FRAME.slice(-12)), `log leaks the frame: ${line}`);
  }
  assert(!JSON.stringify({ warnings: integrity.warnings, checks: [...integrity.checks] }).includes("base64"));
});

Deno.test("pause: auth, ownership, and method are checked before pausing", async () => {
  const { handler, pauseCalls } = setup({ interview: inProgress });
  await expectError(await handler(post(`/interviews/${INTERVIEW_ID}/pause`, "Bearer nope")), 401, "unauthorized");
  await expectError(await handler(post("/interviews/not-a-uuid/pause")), 404, "interview_not_found");
  await expectError(await handler(post(`/interviews/${INTERVIEW_ID}/pause`, "Bearer valid", "GET")), 405, "method_not_allowed");
  await expectError(await setup({ interview: null }).handler(post(`/interviews/${INTERVIEW_ID}/pause`)), 404, "interview_not_found");
  assertEquals(pauseCalls, []);
});

Deno.test("pause: returns the pauses left and the 1-hour resume deadline", async () => {
  const { handler, pauseCalls } = setup({ interview: inProgress });
  const res = await handler(post(`/interviews/${INTERVIEW_ID}/pause`));
  assertEquals(res.status, 201);
  assertEquals(pauseInterviewResponseSchema.parse(await res.json()), {
    status: "paused",
    pauses_left: 2,
    resume_by: at(3600),
  });
  assertEquals(pauseCalls, [{ op: "pause", interviewId: INTERVIEW_ID, userId }]);
});

Deno.test("pause: repeating it while paused answers 200 with the same deadline", async () => {
  const pausedAt = at(-600);
  const { handler } = setup({
    interview: { ...interviewRow, status: "paused" },
    pauseResult: { status: "already_paused", pauseCount: 2, pausedAt, disconnectedSequence: null },
  });
  const res = await handler(post(`/interviews/${INTERVIEW_ID}/pause`));
  assertEquals(res.status, 200);
  assertEquals(pauseInterviewResponseSchema.parse(await res.json()), { status: "paused", pauses_left: 1, resume_by: at(3000) });
});

Deno.test("pause: the limit and inactive interviews are refused", async () => {
  await expectError(
    await setup({
      interview: inProgress,
      pauseResult: { status: "limit_reached", pauseCount: 3, pausedAt: null, disconnectedSequence: null },
    }).handler(post(`/interviews/${INTERVIEW_ID}/pause`)),
    409,
    "pause_limit_reached",
  );
  await expectError(
    await setup({
      interview: completed,
      pauseResult: { status: "not_active", pauseCount: 0, pausedAt: null, disconnectedSequence: null },
    }).handler(post(`/interviews/${INTERVIEW_ID}/pause`)),
    409,
    "interview_not_active",
  );
});

Deno.test("pause: closing an open voice segment writes its duration estimates", async () => {
  const segmentEvents: VoiceSegmentEvent[] = [
    { id: CONNECTED_ID, sequence: 6, event_type: "connected", occurred_at: at(-60) },
    { id: "eeeeeeee-0000-4000-8000-000000000003", sequence: 7, event_type: "disconnected", occurred_at: at(0) },
  ];
  const { handler, usage } = setup({
    interview: inProgress,
    segmentEvents,
    pauseResult: { status: "paused", pauseCount: 1, pausedAt: NOW.toISOString(), disconnectedSequence: 7 },
  });
  assertEquals((await handler(post(`/interviews/${INTERVIEW_ID}/pause`))).status, 201);
  assertEquals(usage.map((u) => [u.voiceSegmentEventId, u.audioSeconds]), [[CONNECTED_ID, 60], [CONNECTED_ID, 60]]);
});

Deno.test("resume: a paused interview goes back in progress", async () => {
  const { handler, pauseCalls } = setup({ interview: { ...interviewRow, status: "paused" } });
  const res = await handler(post(`/interviews/${INTERVIEW_ID}/resume`));
  assertEquals(res.status, 200);
  assertEquals(resumeInterviewResponseSchema.parse(await res.json()), { status: "in_progress" });
  assertEquals(pauseCalls, [{ op: "resume", interviewId: INTERVIEW_ID, userId }]);

  const again = await setup({ interview: inProgress, resumeResult: "already_active" }).handler(post(`/interviews/${INTERVIEW_ID}/resume`));
  assertEquals(again.status, 200);
});

Deno.test("resume: an expired pause and an ended interview are refused", async () => {
  await expectError(
    await setup({ interview: { ...interviewRow, status: "paused" }, resumeResult: "expired" }).handler(
      post(`/interviews/${INTERVIEW_ID}/resume`),
    ),
    409,
    "pause_expired",
  );
  await expectError(
    await setup({ interview: completed, resumeResult: "not_active" }).handler(post(`/interviews/${INTERVIEW_ID}/resume`)),
    409,
    "interview_not_active",
  );
});

Deno.test("end: auth, ownership, and method are checked before ending", async () => {
  const { handler, pauseCalls } = setup({ interview: inProgress });
  await expectError(await handler(post(`/interviews/${INTERVIEW_ID}/end`, "Bearer nope")), 401, "unauthorized");
  await expectError(await handler(post("/interviews/not-a-uuid/end")), 404, "interview_not_found");
  await expectError(await handler(post(`/interviews/${INTERVIEW_ID}/end`, "Bearer valid", "GET")), 405, "method_not_allowed");
  await expectError(await setup({ interview: null }).handler(post(`/interviews/${INTERVIEW_ID}/end`)), 404, "interview_not_found");
  assertEquals(pauseCalls, []);
});

Deno.test("end: with an evaluated answer the interview completes and a report is queued", async () => {
  const { handler, pauseCalls, jobs, reportJobs } = setup({ interview: inProgress });
  const res = await handler(post(`/interviews/${INTERVIEW_ID}/end`));
  assertEquals(res.status, 201);
  assertEquals(endInterviewResponseSchema.parse(await res.json()), { status: "completed", report: true });
  assertEquals(pauseCalls, [{ op: "end", interviewId: INTERVIEW_ID, userId }]);
  assertEquals(reportJobs.requests, [INTERVIEW_ID]);
  assertEquals(jobs.sent.map((s) => s.name), ["interview.report.requested"]);
});

Deno.test("end: with no evaluated answer it terminates without a report", async () => {
  const { handler, reportJobs } = setup({
    interview: { ...interviewRow, status: "paused" },
    endResult: { status: "no_report", disconnectedSequence: null },
  });
  const res = await handler(post(`/interviews/${INTERVIEW_ID}/end`));
  assertEquals(res.status, 201);
  assertEquals(endInterviewResponseSchema.parse(await res.json()), { status: "terminated", report: false });
  assertEquals(reportJobs.requests, []);
});

Deno.test("end: repeating it after the interview ended answers 200 and queues nothing", async () => {
  const done = setup({ interview: completed, endResult: { status: "already_completed", disconnectedSequence: null } });
  const res = await done.handler(post(`/interviews/${INTERVIEW_ID}/end`));
  assertEquals(res.status, 200);
  assertEquals(endInterviewResponseSchema.parse(await res.json()), { status: "completed", report: true });
  assertEquals(done.reportJobs.requests, []);

  const ended = setup({
    interview: { ...interviewRow, status: "terminated" },
    endResult: { status: "already_terminated", disconnectedSequence: null },
  });
  const again = await ended.handler(post(`/interviews/${INTERVIEW_ID}/end`));
  assertEquals(again.status, 200);
  assertEquals(endInterviewResponseSchema.parse(await again.json()), { status: "terminated", report: false });
});

Deno.test("end: an interview that is not active is refused", async () => {
  const { handler, reportJobs } = setup({ endResult: { status: "not_active", disconnectedSequence: null } });
  await expectError(await handler(post(`/interviews/${INTERVIEW_ID}/end`)), 409, "interview_not_active");
  assertEquals(reportJobs.requests, []);
});

Deno.test("end: closing an open voice segment writes its duration estimates", async () => {
  const segmentEvents: VoiceSegmentEvent[] = [
    { id: CONNECTED_ID, sequence: 6, event_type: "connected", occurred_at: at(-90) },
    { id: "eeeeeeee-0000-4000-8000-000000000004", sequence: 7, event_type: "disconnected", occurred_at: at(0) },
  ];
  const { handler, usage } = setup({
    interview: inProgress,
    segmentEvents,
    endResult: { status: "completed", disconnectedSequence: 7 },
  });
  assertEquals((await handler(post(`/interviews/${INTERVIEW_ID}/end`))).status, 201);
  assertEquals(usage.map((u) => [u.voiceSegmentEventId, u.audioSeconds]), [[CONNECTED_ID, 90], [CONNECTED_ID, 90]]);
});

Deno.test("delete: an ended interview is deleted", async () => {
  const { handler, pauseCalls } = setup({ interview: completed });
  const res = await handler(post(`/interviews/${INTERVIEW_ID}`, "Bearer valid", "DELETE"));
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("access-control-allow-origin"), webOrigin);
  assertEquals(deleteInterviewResponseSchema.parse(await res.json()), { status: "deleted" });
  assertEquals(pauseCalls, [{ op: "delete", interviewId: INTERVIEW_ID, userId }]);
});

Deno.test("delete: repeating it answers the same way", async () => {
  const { handler } = setup({
    interview: { ...interviewRow, status: "terminated" },
    deleteResult: { status: "already_deleted", disconnectedSequence: null },
  });
  const res = await handler(post(`/interviews/${INTERVIEW_ID}/`, "Bearer valid", "DELETE"));
  assertEquals(res.status, 200);
  assertEquals(deleteInterviewResponseSchema.parse(await res.json()), { status: "deleted" });
});

Deno.test("delete: a pending, in-progress or paused interview is deleted without a report", async () => {
  for (const status of ["created", "in_progress", "paused"] as const) {
    const { handler, pauseCalls, reportJobs, usage } = setup({ interview: { ...interviewRow, status } });
    const res = await handler(post(`/interviews/${INTERVIEW_ID}`, "Bearer valid", "DELETE"));
    assertEquals(res.status, 200);
    assertEquals(deleteInterviewResponseSchema.parse(await res.json()), { status: "deleted" });
    assertEquals(pauseCalls, [{ op: "delete", interviewId: INTERVIEW_ID, userId }]);
    assertEquals(reportJobs.requests, []);
    assertEquals(usage, []);
  }
});

Deno.test("delete: closing an open voice segment writes its duration estimates", async () => {
  const segmentEvents: VoiceSegmentEvent[] = [
    { id: CONNECTED_ID, sequence: 6, event_type: "connected", occurred_at: at(-90) },
    { id: "eeeeeeee-0000-4000-8000-000000000004", sequence: 7, event_type: "disconnected", occurred_at: at(0) },
  ];
  const { handler, usage, reportJobs } = setup({
    interview: inProgress,
    segmentEvents,
    deleteResult: { status: "deleted", disconnectedSequence: 7 },
  });
  assertEquals((await handler(post(`/interviews/${INTERVIEW_ID}`, "Bearer valid", "DELETE"))).status, 200);
  assertEquals(usage.map((u) => [u.voiceSegmentEventId, u.audioSeconds]), [[CONNECTED_ID, 90], [CONNECTED_ID, 90]]);
  assertEquals(reportJobs.requests, []);
});

Deno.test("delete: auth, ownership, and method are checked before deleting", async () => {
  const { handler, pauseCalls } = setup({ interview: completed });
  await expectError(await handler(post(`/interviews/${INTERVIEW_ID}`, "Bearer nope", "DELETE")), 401, "unauthorized");
  await expectError(await handler(post("/interviews/not-a-uuid", "Bearer valid", "DELETE")), 404, "interview_not_found");
  const wrongMethod = await handler(post(`/interviews/${INTERVIEW_ID}`, "Bearer valid", "POST"));
  await expectError(wrongMethod, 405, "method_not_allowed");
  assertEquals(wrongMethod.headers.get("allow"), "DELETE, OPTIONS");
  // Deleted and other users' interviews are hidden by RLS.
  await expectError(
    await setup({ interview: null }).handler(post(`/interviews/${INTERVIEW_ID}`, "Bearer valid", "DELETE")),
    404,
    "interview_not_found",
  );
  assertEquals(pauseCalls, []);

  const raced = setup({ interview: completed, deleteResult: { status: "not_found", disconnectedSequence: null } });
  await expectError(await raced.handler(post(`/interviews/${INTERVIEW_ID}`, "Bearer valid", "DELETE")), 404, "interview_not_found");
});

Deno.test("delete: the CORS preflight allows DELETE", async () => {
  const { handler } = setup();
  const res = await handler(post(`/interviews/${INTERVIEW_ID}`, "Bearer valid", "OPTIONS"));
  assertEquals(res.status, 204);
  assert(res.headers.get("access-control-allow-methods")?.includes("DELETE"));
});

Deno.test("a paused interview cannot mint a voice session", async () => {
  const { handler, openaiRequests } = setup({ interview: { ...interviewRow, status: "paused" } });
  await expectError(await handler(post()), 409, "interview_paused");
  assertEquals(openaiRequests.length, 0);
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
