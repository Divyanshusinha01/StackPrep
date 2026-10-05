import { describe, expect, it } from "vitest";
import { apiErrorCodeSchema } from "./github.ts";
import {
  advanceInterviewInputSchema,
  endInterviewInputSchema,
  evaluateAnswerOutputSchema,
  getFileInputSchema,
  REALTIME_TOOLS,
  realtimeSessionResponseSchema,
  realtimeToolNameSchema,
  searchRepositoryInputSchema,
  toolErrorSchema,
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
  });
});

describe("interview API error codes", () => {
  it.each(["interview_not_found", "interview_preparing", "interview_planning_failed", "interview_not_active", "realtime_unavailable"])(
    "includes %s",
    (code) => {
      expect(apiErrorCodeSchema.safeParse(code).success).toBe(true);
    },
  );
});
