import { describe, expect, it } from "vitest";
import { apiErrorCodeSchema } from "./github.ts";
import {
  maskOpenAIKey,
  openAIKeyStatusResponseSchema,
  redactOpenAIKeys,
  saveOpenAIKeyRequestSchema,
} from "./openai-key.ts";
import { reportErrorCodeSchema } from "./reports.ts";
import { deepAnalysisErrorCodeSchema, planningErrorCodeSchema } from "./workspaces.ts";

const projectKey = `sk-proj-${"a".repeat(40)}`;

describe("redactOpenAIKeys", () => {
  it("redacts keys in nested strings in place and leaves hints and other values", () => {
    const value = { a: `x ${projectKey} y`, b: [projectKey, 1, null], c: { hint: "sk-...aaaa", ok: true } };
    expect(redactOpenAIKeys(value)).toBe(value);
    expect(value).toEqual({ a: "x sk-[redacted] y", b: ["sk-[redacted]", 1, null], c: { hint: "sk-...aaaa", ok: true } });
    expect(redactOpenAIKeys(`k=${projectKey}`)).toBe("k=sk-[redacted]");
  });
});

describe("saveOpenAIKeyRequestSchema", () => {
  it("accepts project and user secret keys, trimmed", () => {
    expect(saveOpenAIKeyRequestSchema.parse({ api_key: ` ${projectKey} ` })).toEqual({ api_key: projectKey });
    expect(saveOpenAIKeyRequestSchema.safeParse({ api_key: `sk-${"B".repeat(48)}` }).success).toBe(true);
  });

  it.each([
    ["an admin key", `sk-admin-${"a".repeat(40)}`],
    ["a short key", "sk-abc"],
    ["a key without the prefix", "a".repeat(40)],
    ["a key with spaces", `sk-${"a".repeat(20)} ${"b".repeat(20)}`],
    ["an overlong key", `sk-${"a".repeat(201)}`],
  ])("rejects %s", (_label, key) => {
    expect(saveOpenAIKeyRequestSchema.safeParse({ api_key: key }).success).toBe(false);
  });

  it("rejects unknown fields", () => {
    expect(saveOpenAIKeyRequestSchema.safeParse({ api_key: projectKey, user_id: "x" }).success).toBe(false);
  });
});

describe("openAIKeyStatusResponseSchema", () => {
  it("parses both shapes", () => {
    expect(openAIKeyStatusResponseSchema.parse({ configured: false })).toEqual({ configured: false });
    const configured = {
      configured: true,
      status: "quota_exhausted",
      key_hint: maskOpenAIKey(projectKey),
      validated_at: "2026-10-16T10:00:00.000Z",
      last_error_code: "insufficient_quota",
    };
    expect(openAIKeyStatusResponseSchema.parse(configured)).toEqual(configured);
  });

  it("rejects a hint that reveals more than the last four characters", () => {
    expect(
      openAIKeyStatusResponseSchema.safeParse({
        configured: true,
        status: "valid",
        key_hint: projectKey,
        validated_at: null,
        last_error_code: null,
      }).success,
    ).toBe(false);
  });
});

describe("maskOpenAIKey", () => {
  it("keeps only the prefix and the last four characters", () => {
    expect(maskOpenAIKey(`sk-proj-${"x".repeat(30)}wxyz`)).toBe("sk-...wxyz");
  });
});

describe("BYOK error codes", () => {
  it("are part of the API and job contracts", () => {
    for (const code of ["openai_key_required", "openai_key_invalid", "openai_quota_exhausted", "openai_rate_limited"]) {
      expect(apiErrorCodeSchema.safeParse(code).success).toBe(true);
    }
    for (const schema of [planningErrorCodeSchema, deepAnalysisErrorCodeSchema, reportErrorCodeSchema]) {
      for (const code of ["openai_key_unavailable", "openai_key_invalid", "openai_quota_exhausted"]) {
        expect(schema.safeParse(code).success).toBe(true);
      }
    }
  });
});
