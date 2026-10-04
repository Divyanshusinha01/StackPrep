import { describe, expect, it } from "vitest";
import { edgeEnvSchema, parseEnv, webEnvSchema } from "./env.ts";

describe("parseEnv", () => {
  it("parses a valid edge env", () => {
    const env = parseEnv("edge", edgeEnvSchema, { WEB_ORIGIN: "https://stackprep.dev" });
    expect(env).toEqual({ WEB_ORIGIN: "https://stackprep.dev" });
  });

  it("reports every invalid web variable in one error", () => {
    expect(() =>
      parseEnv("web", webEnvSchema, { NODE_ENV: "staging", NEXT_PUBLIC_SUPABASE_URL: undefined }),
    ).toThrowError(/Invalid web environment variables:[\s\S]*NODE_ENV[\s\S]*NEXT_PUBLIC_SUPABASE_URL/);
  });

  it("rejects a non-http Supabase url for web", () => {
    expect(() =>
      parseEnv("web", webEnvSchema, { NODE_ENV: "development", NEXT_PUBLIC_SUPABASE_URL: "ftp://x.dev" }),
    ).toThrowError(/NEXT_PUBLIC_SUPABASE_URL/);
  });

  it("requires WEB_ORIGIN for edge functions", () => {
    expect(() => parseEnv("edge", edgeEnvSchema, {})).toThrowError(/WEB_ORIGIN/);
  });
});
