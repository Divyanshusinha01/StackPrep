import { describe, expect, it } from "vitest";
import { healthResponseSchema } from "./health.ts";

describe("healthResponseSchema", () => {
  it("accepts a valid payload", () => {
    const payload = { status: "ok", service: "api", timestamp: new Date().toISOString() };
    expect(healthResponseSchema.parse(payload)).toEqual(payload);
  });

  it("rejects an unexpected status", () => {
    expect(healthResponseSchema.safeParse({ status: "down", service: "api", timestamp: new Date().toISOString() }).success).toBe(false);
  });
});
