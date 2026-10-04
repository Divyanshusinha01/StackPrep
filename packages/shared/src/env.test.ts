import { describe, expect, it } from "vitest";
import { apiEnvSchema, parseEnv, webEnvSchema, workerEnvSchema } from "./env.ts";

describe("parseEnv", () => {
  it("parses a valid api env and coerces PORT", () => {
    const env = parseEnv("api", apiEnvSchema, {
      NODE_ENV: "production",
      PORT: "8787",
      WEB_ORIGIN: "https://stackprep.dev",
    });
    expect(env).toEqual({ NODE_ENV: "production", PORT: 8787, WEB_ORIGIN: "https://stackprep.dev" });
  });

  it("reports every invalid api variable in one error", () => {
    expect(() =>
      parseEnv("api", apiEnvSchema, { NODE_ENV: "staging", PORT: "abc", WEB_ORIGIN: undefined }),
    ).toThrowError(/Invalid api environment variables:[\s\S]*NODE_ENV[\s\S]*PORT[\s\S]*WEB_ORIGIN/);
  });

  it("rejects a non-http API url for web", () => {
    expect(() =>
      parseEnv("web", webEnvSchema, { NODE_ENV: "development", NEXT_PUBLIC_API_URL: "ftp://x.dev" }),
    ).toThrowError(/NEXT_PUBLIC_API_URL/);
  });

  it("requires NODE_ENV for the worker", () => {
    expect(() => parseEnv("worker", workerEnvSchema, {})).toThrowError(/NODE_ENV/);
  });
});
