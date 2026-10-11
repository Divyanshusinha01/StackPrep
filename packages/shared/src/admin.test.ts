import { describe, expect, it } from "vitest";
import {
  adminEnvSchema,
  adminMetricsResponseSchema,
  adminWindowDaysSchema,
  isAdminUserId,
  parseAdminUserIds,
} from "./admin.ts";
import { parseEnv } from "./env.ts";

const alice = "aaaaaaaa-0000-4000-8000-000000000001";
const bob = "bbbbbbbb-0000-4000-8000-000000000002";

describe("parseAdminUserIds", () => {
  it("accepts a comma-separated list of UUIDs, trimming and lowercasing", () => {
    expect([...parseAdminUserIds(` ${alice} , ${bob.toUpperCase()},`)]).toEqual([alice, bob]);
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["only separators", " , ,"],
    ["an email", "admin@example.com"],
    ["one malformed entry among valid ones", `${alice},not-a-uuid`],
    ["an email next to a valid id", `${alice},${"bob@example.com"}`],
  ])("fails closed when %s", (_, raw) => {
    expect(parseAdminUserIds(raw).size).toBe(0);
  });
});

describe("isAdminUserId", () => {
  const admins = parseAdminUserIds(alice);

  it("matches an allowlisted id regardless of case", () => {
    expect(isAdminUserId(admins, alice)).toBe(true);
    expect(isAdminUserId(admins, alice.toUpperCase())).toBe(true);
  });

  it("rejects other, missing, and empty ids", () => {
    expect(isAdminUserId(admins, bob)).toBe(false);
    expect(isAdminUserId(admins, null)).toBe(false);
    expect(isAdminUserId(admins, undefined)).toBe(false);
    expect(isAdminUserId(admins, "")).toBe(false);
    expect(isAdminUserId(new Set(), alice)).toBe(false);
  });
});

describe("adminEnvSchema", () => {
  it("never throws on a malformed allowlist", () => {
    expect(parseEnv("admin", adminEnvSchema, { ADMIN_USER_IDS: "nope" }).ADMIN_USER_IDS.size).toBe(0);
    expect(parseEnv("admin", adminEnvSchema, {}).ADMIN_USER_IDS.size).toBe(0);
    expect([...parseEnv("admin", adminEnvSchema, { ADMIN_USER_IDS: alice }).ADMIN_USER_IDS]).toEqual([alice]);
  });
});

describe("adminWindowDaysSchema", () => {
  it("accepts only the offered windows", () => {
    expect(adminWindowDaysSchema.parse("7")).toBe(7);
    for (const days of ["0", "2", "91", "-1", "7.5", "abc", ""]) {
      expect(adminWindowDaysSchema.safeParse(days).success).toBe(false);
    }
  });
});

describe("adminMetricsResponseSchema", () => {
  it("coerces numeric strings and strips unknown fields", () => {
    const parsed = adminMetricsResponseSchema.parse({
      window_days: 7,
      interview_cost: [{
        interview_id: alice,
        interview_created_at: "2026-10-11T10:00:00Z",
        cost_usd: "1.25",
        voice_cost_usd: "1",
        text_cost_usd: "0.25",
        calls: 3,
        unpriced_calls: 0,
        has_estimate: false,
        email: "leak@example.com",
      }],
      voice_text_split: [],
      cache_hit_rate: [],
      tool_latency: [],
    });
    expect(parsed.interview_cost[0]?.cost_usd).toBe(1.25);
    expect(parsed.interview_cost[0]).not.toHaveProperty("email");
  });
});
