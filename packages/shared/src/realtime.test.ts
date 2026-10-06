import { describe, expect, it } from "vitest";
import { apiErrorCodeSchema } from "./github.ts";
import {
  advanceInterviewInputSchema,
  endInterviewInputSchema,
  evaluateAnswerOutputSchema,
  evidenceExaminedPayloadSchema,
  formatInterviewStreamCursor,
  getFileInputSchema,
  INITIAL_INTERVIEW_STREAM_CURSOR,
  interviewStreamEventSchema,
  parseInterviewStreamCursor,
  INTEGRITY_FRAME_MAX_CHARS,
  integrityFrameRequestSchema,
  integrityFrameResponseSchema,
  interviewEventAckSchema,
  interviewEventRequestSchema,
  REALTIME_TOOLS,
  realtimeSessionResponseSchema,
  realtimeToolNameSchema,
  searchRepositoryInputSchema,
  TOOL_CALL_ARGUMENTS_MAX_CHARS,
  toolCallEventPayloadSchema,
  toolCallRequestSchema,
  toolCallResponseSchema,
  toolErrorSchema,
  TRANSCRIPT_TURN_MAX_CHARS,
  VOICE_LIMIT_SECONDS,
} from "./realtime.ts";

const session = {
  client_secret: "ek_abc",
  expires_at: "2026-10-05T12:00:00.000Z",
  model: "gpt-realtime-2.1-mini",
  remaining_voice_seconds: VOICE_LIMIT_SECONDS,
  resume: null,
};

describe("realtimeSessionResponseSchema", () => {
  it("accepts a session and strips unknown fields", () => {
    expect(realtimeSessionResponseSchema.parse({ ...session, api_key: "sk-x" })).toEqual(session);
  });

  it("accepts a resume point", () => {
    const resume = { last_turn_sequence: 7, current_question: "How is auth handled?" };
    expect(realtimeSessionResponseSchema.parse({ ...session, resume }).resume).toEqual(resume);
    expect(realtimeSessionResponseSchema.parse({ ...session, resume: { last_turn_sequence: 0, current_question: null } }).resume)
      .toEqual({ last_turn_sequence: 0, current_question: null });
  });

  it.each([
    ["no voice time left", { ...session, remaining_voice_seconds: 0 }],
    ["more than the cap", { ...session, remaining_voice_seconds: VOICE_LIMIT_SECONDS + 1 }],
    ["empty secret", { ...session, client_secret: "" }],
    ["non-ISO expiry", { ...session, expires_at: "tomorrow" }],
    ["a missing resume field", { ...session, resume: undefined }],
    ["a negative resume sequence", { ...session, resume: { last_turn_sequence: -1, current_question: null } }],
  ])("rejects %s", (_label, body) => {
    expect(realtimeSessionResponseSchema.safeParse(body).success).toBe(false);
  });
});

describe("tool schemas", () => {
  it("declares exactly the five catalogue tools", () => {
    expect(Object.keys(REALTIME_TOOLS).sort()).toEqual([...realtimeToolNameSchema.options].sort());
  });

  it("never accepts an interview id or other identifiers", () => {
    const id = "aaaaaaaa-0000-4000-8000-000000000001";
    expect(searchRepositoryInputSchema.safeParse({ query: "auth", interview_id: id }).success).toBe(false);
    expect(advanceInterviewInputSchema.safeParse({ interview_id: id }).success).toBe(false);
    expect(endInterviewInputSchema.safeParse({ reason: "time_target", interviewId: id }).success).toBe(false);
  });

  it("applies limits and defaults", () => {
    expect(searchRepositoryInputSchema.parse({ query: " auth " })).toEqual({ query: "auth", limit: 5 });
    expect(searchRepositoryInputSchema.safeParse({ query: "x", limit: 9 }).success).toBe(false);
    expect(searchRepositoryInputSchema.safeParse({ query: "x".repeat(201) }).success).toBe(false);
    expect(getFileInputSchema.safeParse({ path: "", startLine: 1 }).success).toBe(false);
    expect(getFileInputSchema.safeParse({ path: "src/a.ts", startLine: 0 }).success).toBe(false);
  });

  it("keeps evaluation output free of scores", () => {
    expect(evaluateAnswerOutputSchema.parse({ ok: true, guidance: "move_on", score: 9 })).toEqual({
      ok: true,
      guidance: "move_on",
    });
  });

  it("parses tool errors", () => {
    expect(toolErrorSchema.parse({ ok: false, error: { code: "unknown_tool" } }).error.code).toBe("unknown_tool");
    expect(toolErrorSchema.safeParse({ ok: false, error: { code: "boom" } }).success).toBe(false);
    expect(toolErrorSchema.safeParse({ ok: false, error: { code: "internal" }, guidance: "x".repeat(301) }).success)
      .toBe(false);
  });
});

describe("toolCallRequestSchema", () => {
  const call = { call_id: "call_1", name: "get_file", arguments: '{"path":"src/a.ts"}' };

  it("accepts string or object arguments and any tool name", () => {
    expect(toolCallRequestSchema.parse(call)).toEqual(call);
    expect(toolCallRequestSchema.parse({ ...call, arguments: { path: "src/a.ts" } }).arguments).toEqual({
      path: "src/a.ts",
    });
    expect(toolCallRequestSchema.safeParse({ ...call, name: "drop_tables" }).success).toBe(true);
  });

  it.each([
    ["an empty call id", { ...call, call_id: "" }],
    ["a long call id", { ...call, call_id: "c".repeat(129) }],
    ["oversized string arguments", { ...call, arguments: "x".repeat(TOOL_CALL_ARGUMENTS_MAX_CHARS + 1) }],
    ["oversized object arguments", { ...call, arguments: { path: "x".repeat(TOOL_CALL_ARGUMENTS_MAX_CHARS) } }],
    ["array arguments", { ...call, arguments: [] }],
    ["an interview id", { ...call, interview_id: CLIENT_EVENT_ID }],
  ])("rejects %s", (_label, body) => {
    expect(toolCallRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe("toolCallResponseSchema", () => {
  it.each([
    { ok: false, error: { code: "interview_not_active" }, guidance: "Close now." },
    { ok: true, results: [{ path: "src/a.ts", excerpt: "x" }] },
    { ok: true, path: "a", startLine: 1, endLine: 1, totalLines: 1, content: "", truncated: false },
    { ok: true, guidance: "follow_up", focus: "token rotation" },
    { ok: true, nextFocus: { area: "src/auth", category: "Security", angle: "x" }, depth: "deep", elapsedMinutes: 3 },
    { ok: true, accepted: false, guidance: "Continue." },
  ])("accepts tool result %#", (body) => {
    expect(toolCallResponseSchema.safeParse(body).success).toBe(true);
  });

  it("rejects unrelated bodies", () => {
    expect(toolCallResponseSchema.safeParse({ ok: true }).success).toBe(false);
    expect(toolCallResponseSchema.safeParse({ error: "Unauthorized", code: "unauthorized" }).success).toBe(false);
  });
});

describe("tool event payloads", () => {
  it("validates evidence_examined payloads", () => {
    expect(evidenceExaminedPayloadSchema.parse({ path: "src/a.ts", area: "src", tool: "get_file" })).toBeTruthy();
    expect(evidenceExaminedPayloadSchema.safeParse({ path: "src/a.ts", tool: "evaluate_answer" }).success).toBe(false);
    expect(evidenceExaminedPayloadSchema.safeParse({ path: "src/a.ts", tool: "get_file", content: "x" }).success)
      .toBe(false);
  });

  it("validates tool_call payloads", () => {
    const payload = { call_id: "c1", tool: "get_file", args: { path: "a" }, result_summary: { ok: true } };
    expect(toolCallEventPayloadSchema.parse(payload)).toEqual(payload);
    expect(toolCallEventPayloadSchema.safeParse({ ...payload, tool: "nope" }).success).toBe(false);
  });
});

const CLIENT_EVENT_ID = "bbbbbbbb-0000-4000-8000-000000000001";
const OCCURRED_AT = "2026-10-05T12:00:00.000Z";

const turn = {
  type: "transcript_turn",
  client_event_id: CLIENT_EVENT_ID,
  role: "user",
  content: "It uses Postgres.",
  item_id: "item_1",
  occurred_at: OCCURRED_AT,
};

describe("interviewEventRequestSchema", () => {
  it("accepts transcript turns and trims content", () => {
    expect(interviewEventRequestSchema.parse({ ...turn, content: "  hi  ", interrupted: true })).toEqual({
      ...turn,
      content: "hi",
      interrupted: true,
    });
  });

  it.each(["connected", "disconnected", "resume"])("accepts %s without a sequence", (type) => {
    const event = { type, client_event_id: CLIENT_EVENT_ID, occurred_at: OCCURRED_AT };
    expect(interviewEventRequestSchema.parse(event)).toEqual(event);
  });

  it.each(["camera", "microphone", "network", "connection"])("accepts a pause caused by %s", (reason) => {
    const event = { type: "pause", reason, client_event_id: CLIENT_EVENT_ID, occurred_at: OCCURRED_AT };
    expect(interviewEventRequestSchema.parse(event)).toEqual(event);
  });

  it.each([
    ["a pause without a reason", { type: "pause", client_event_id: CLIENT_EVENT_ID, occurred_at: OCCURRED_AT }],
    ["a voluntary pause", { type: "pause", reason: "user", client_event_id: CLIENT_EVENT_ID, occurred_at: OCCURRED_AT }],
    ["a resume with a reason", { type: "resume", reason: "network", client_event_id: CLIENT_EVENT_ID, occurred_at: OCCURRED_AT }],
  ])("rejects %s", (_label, body) => {
    expect(interviewEventRequestSchema.safeParse(body).success).toBe(false);
  });

  it.each([
    ["a turn with a browser sequence", { ...turn, sequence: 1 }],
    ["a voice event with a browser sequence", { type: "connected", client_event_id: CLIENT_EVENT_ID, occurred_at: OCCURRED_AT, sequence: 3 }],
    ["an unknown type", { ...turn, type: "tool_call" }],
    ["a system turn", { ...turn, role: "system" }],
    ["blank content", { ...turn, content: "   " }],
    ["oversized content", { ...turn, content: "x".repeat(TRANSCRIPT_TURN_MAX_CHARS + 1) }],
    ["a non-uuid event id", { ...turn, client_event_id: "abc" }],
    ["a missing item id", { ...turn, item_id: "" }],
    ["a non-ISO time", { ...turn, occurred_at: "now" }],
    ["extra fields", { ...turn, interview_id: CLIENT_EVENT_ID }],
  ])("rejects %s", (_label, body) => {
    expect(interviewEventRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe("interviewEventAckSchema", () => {
  const turnAck = { type: "transcript_turn", status: "created", client_event_id: CLIENT_EVENT_ID, turn_sequence: 4 };
  const voiceAck = { type: "connected", status: "duplicate", client_event_id: CLIENT_EVENT_ID, event_sequence: 9 };

  it("accepts turn and voice acks", () => {
    expect(interviewEventAckSchema.parse(turnAck)).toEqual(turnAck);
    expect(interviewEventAckSchema.parse(voiceAck)).toEqual(voiceAck);
    expect(interviewEventAckSchema.parse({ ...voiceAck, type: "pause" }).type).toBe("pause");
    expect(interviewEventAckSchema.parse({ ...voiceAck, type: "resume" }).type).toBe("resume");
  });

  it.each([
    ["a turn ack with event_sequence", { ...turnAck, turn_sequence: undefined, event_sequence: 4 }],
    ["a turn ack carrying both sequences", { ...turnAck, event_sequence: 4 }],
    ["a voice ack with turn_sequence", { ...voiceAck, event_sequence: undefined, turn_sequence: 9 }],
    ["a bare sequence", { type: "transcript_turn", status: "created", client_event_id: CLIENT_EVENT_ID, sequence: 4 }],
    ["an unknown status", { ...turnAck, status: "event_conflict" }],
  ])("rejects %s", (_label, body) => {
    expect(interviewEventAckSchema.safeParse(body).success).toBe(false);
  });

  it("accepts a voice usage ack without a sequence", () => {
    const ack = { type: "voice_usage", status: "created", client_event_id: CLIENT_EVENT_ID };
    expect(interviewEventAckSchema.parse(ack)).toEqual(ack);
    expect(interviewEventAckSchema.safeParse({ ...ack, event_sequence: 1 }).success).toBe(false);
  });
});

describe("voice usage events", () => {
  const usage = {
    type: "voice_usage",
    client_event_id: CLIENT_EVENT_ID,
    response_id: "resp_1",
    input_tokens: 120,
    cached_input_tokens: 100,
    output_tokens: 30,
    audio_input_tokens: 900,
    audio_cached_input_tokens: 0,
    audio_output_tokens: 400,
    occurred_at: OCCURRED_AT,
  };

  it("accepts relayed response.done usage", () => {
    expect(interviewEventRequestSchema.parse(usage)).toEqual(usage);
  });

  it.each([
    ["negative tokens", { ...usage, output_tokens: -1 }],
    ["fractional tokens", { ...usage, audio_input_tokens: 1.5 }],
    ["a missing token field", { ...usage, audio_output_tokens: undefined }],
    ["an empty response id", { ...usage, response_id: "" }],
    ["a client-supplied cost", { ...usage, estimated_cost_usd: 0.01 }],
    ["a client-supplied model", { ...usage, model: "gpt-5.6-luna" }],
  ])("rejects %s", (_label, body) => {
    expect(interviewEventRequestSchema.safeParse(body).success).toBe(false);
  });

  it("adds the voice_not_connected error code", () => {
    expect(apiErrorCodeSchema.safeParse("voice_not_connected").success).toBe(true);
  });
});

describe("integrity frame contracts", () => {
  const image = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";

  it("accepts a base64 JPEG data URL", () => {
    expect(integrityFrameRequestSchema.parse({ image })).toEqual({ image });
  });

  it.each([
    ["a PNG", { image: "data:image/png;base64,iVBORw0KGgo=" }],
    ["a remote URL", { image: "https://evil.example/a.jpg" }],
    ["non-base64 data", { image: "data:image/jpeg;base64,<script>" }],
    ["an oversized frame", { image: `data:image/jpeg;base64,${"A".repeat(INTEGRITY_FRAME_MAX_CHARS)}` }],
    ["extra fields", { image, interview_id: CLIENT_EVENT_ID }],
  ])("rejects %s", (_label, body) => {
    expect(integrityFrameRequestSchema.safeParse(body).success).toBe(false);
  });

  it("accepts ok, warning, and terminated responses", () => {
    expect(integrityFrameResponseSchema.parse({ status: "ok" })).toEqual({ status: "ok" });
    expect(integrityFrameResponseSchema.parse({ status: "warning", warning_number: 2, message: "Stay focused." }).status)
      .toBe("warning");
    expect(integrityFrameResponseSchema.parse({ status: "terminated", warning_number: 3, message: "Ended." }).status)
      .toBe("terminated");
  });

  it.each([
    ["a third warning that is not a termination", { status: "warning", warning_number: 3, message: "x" }],
    ["a termination before the third signal", { status: "terminated", warning_number: 2, message: "x" }],
    ["a signal kind or image leak", { status: "ok", image: "data:" }],
  ])("rejects %s", (_label, body) => {
    expect(integrityFrameResponseSchema.safeParse(body).success).toBe(false);
  });
});

describe("interview stream contracts", () => {
  it("accepts the three event types", () => {
    expect(interviewStreamEventSchema.parse({
      event: "interview_status",
      data: { status: "completed", event_sequence: 12, occurred_at: "2026-10-05T12:00:00.000Z" },
    }).event).toBe("interview_status");
    expect(interviewStreamEventSchema.parse({
      event: "turn_persisted",
      data: { turn_sequence: 4, role: "user", client_event_id: CLIENT_EVENT_ID, item_id: "item_1" },
    }).event).toBe("turn_persisted");
    expect(interviewStreamEventSchema.parse({
      event: "report_ready",
      data: { generated_at: "2026-10-05T12:00:00.000Z" },
    }).event).toBe("report_ready");
  });

  it.each([
    ["an unstreamed event type", { event: "pause", data: {} }],
    ["a status outside the transitions", { event: "interview_status", data: { status: "paused", event_sequence: 1, occurred_at: "2026-10-05T12:00:00.000Z" } }],
    ["transcript content", { event: "turn_persisted", data: { turn_sequence: 1, role: "ai", client_event_id: CLIENT_EVENT_ID, content: "hi" } }],
    ["report content", { event: "report_ready", data: { generated_at: "2026-10-05T12:00:00.000Z", report: {} } }],
  ])("rejects %s", (_label, body) => {
    expect(interviewStreamEventSchema.safeParse(body).success).toBe(false);
  });

  it("round-trips the composite cursor", () => {
    const cursor = { eventSequence: 12, turnSequence: 40, reportSent: true };
    expect(formatInterviewStreamCursor(cursor)).toBe("12.40.1");
    expect(parseInterviewStreamCursor("12.40.1")).toEqual(cursor);
    expect(formatInterviewStreamCursor(INITIAL_INTERVIEW_STREAM_CURSOR)).toBe("0.0.0");
  });

  it.each(["", "1.2", "1.2.2", "-1.0.0", "a.b.c", "1.2.0 ", "1.2.0.0", "99999999999.0.0"])("rejects the cursor %j", (value) => {
    expect(parseInterviewStreamCursor(value)).toBeNull();
  });
});

describe("interview API error codes", () => {
  it.each(["interview_not_found", "interview_preparing", "interview_planning_failed", "interview_not_active", "realtime_unavailable", "event_conflict", "interview_interrupted", "rate_limited", "invalid_cursor"])(
    "includes %s",
    (code) => {
      expect(apiErrorCodeSchema.safeParse(code).success).toBe(true);
    },
  );
});
