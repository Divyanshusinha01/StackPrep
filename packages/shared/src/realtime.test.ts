import { describe, expect, it } from "vitest";
import { apiErrorCodeSchema } from "./github.ts";
import {
  advanceInterviewInputSchema,
  endInterviewInputSchema,
  evaluateAnswerOutputSchema,
  evidenceExaminedPayloadSchema,
  getFileInputSchema,
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
};

describe("realtimeSessionResponseSchema", () => {
  it("accepts a session and strips unknown fields", () => {
    expect(realtimeSessionResponseSchema.parse({ ...session, api_key: "sk-x" })).toEqual(session);
  });

  it.each([
    ["no voice time left", { ...session, remaining_voice_seconds: 0 }],
    ["more than the cap", { ...session, remaining_voice_seconds: VOICE_LIMIT_SECONDS + 1 }],
    ["empty secret", { ...session, client_secret: "" }],
    ["non-ISO expiry", { ...session, expires_at: "tomorrow" }],
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

  it.each(["connected", "disconnected"])("accepts %s without a sequence", (type) => {
    const event = { type, client_event_id: CLIENT_EVENT_ID, occurred_at: OCCURRED_AT };
    expect(interviewEventRequestSchema.parse(event)).toEqual(event);
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
});

describe("interview API error codes", () => {
  it.each(["interview_not_found", "interview_preparing", "interview_planning_failed", "interview_not_active", "realtime_unavailable", "event_conflict"])(
    "includes %s",
    (code) => {
      expect(apiErrorCodeSchema.safeParse(code).success).toBe(true);
    },
  );
});
