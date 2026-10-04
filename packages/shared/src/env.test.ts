import { describe, expect, it } from "vitest";
import {
  edgeEnvSchema,
  edgeSentryEnvSchema,
  edgeSupabaseEnvSchema,
  githubAppEnvSchema,
  inngestEnvSchema,
  openAIEnvSchema,
  parseEnv,
  webEnvSchema,
  webGithubAppEnvSchema,
  webSentryEnvSchema,
} from "./env.ts";

const validWeb = {
  NODE_ENV: "development",
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_123",
};

describe("parseEnv", () => {
  it("parses a valid edge env", () => {
    const env = parseEnv("edge", edgeEnvSchema, { WEB_ORIGIN: "https://stackprep.dev" });
    expect(env).toEqual({ WEB_ORIGIN: "https://stackprep.dev" });
  });

  it("parses a valid web env", () => {
    expect(parseEnv("web", webEnvSchema, validWeb)).toEqual(validWeb);
  });

  it("reports every invalid web variable in one error", () => {
    expect(() =>
      parseEnv("web", webEnvSchema, { NODE_ENV: "staging", NEXT_PUBLIC_SUPABASE_URL: undefined }),
    ).toThrowError(
      /Invalid web environment variables:[\s\S]*NODE_ENV[\s\S]*NEXT_PUBLIC_SUPABASE_URL[\s\S]*NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY/,
    );
  });

  it("rejects a non-http Supabase url for web", () => {
    expect(() =>
      parseEnv("web", webEnvSchema, { ...validWeb, NEXT_PUBLIC_SUPABASE_URL: "ftp://x.dev" }),
    ).toThrowError(/NEXT_PUBLIC_SUPABASE_URL/);
  });

  it("rejects a blank Supabase publishable key for web", () => {
    expect(() =>
      parseEnv("web", webEnvSchema, { ...validWeb, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "  " }),
    ).toThrowError(/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY/);
  });

  it("requires WEB_ORIGIN for edge functions", () => {
    expect(() => parseEnv("edge", edgeEnvSchema, {})).toThrowError(/WEB_ORIGIN/);
  });
});

describe("integration env schemas", () => {
  it("parses web Sentry env with optional build-time vars omitted", () => {
    expect(
      parseEnv("web sentry", webSentryEnvSchema, { NEXT_PUBLIC_SENTRY_DSN: "https://k@o1.ingest.sentry.io/1" }),
    ).toEqual({ NEXT_PUBLIC_SENTRY_DSN: "https://k@o1.ingest.sentry.io/1" });
  });

  it("rejects a non-url web Sentry DSN", () => {
    expect(() =>
      parseEnv("web sentry", webSentryEnvSchema, { NEXT_PUBLIC_SENTRY_DSN: "not-a-dsn" }),
    ).toThrowError(/NEXT_PUBLIC_SENTRY_DSN/);
  });

  it("parses and rejects the web GitHub App slug", () => {
    expect(parseEnv("web github", webGithubAppEnvSchema, { NEXT_PUBLIC_GITHUB_APP_SLUG: "stackprep" })).toEqual({
      NEXT_PUBLIC_GITHUB_APP_SLUG: "stackprep",
    });
    expect(() => parseEnv("web github", webGithubAppEnvSchema, {})).toThrowError(/NEXT_PUBLIC_GITHUB_APP_SLUG/);
  });

  it("parses and rejects edge Supabase env", () => {
    const valid = {
      SUPABASE_URL: "http://kong:8000",
      SUPABASE_ANON_KEY: "anon",
      SUPABASE_SERVICE_ROLE_KEY: "service",
    };
    expect(parseEnv("edge supabase", edgeSupabaseEnvSchema, valid)).toEqual(valid);
    expect(() =>
      parseEnv("edge supabase", edgeSupabaseEnvSchema, { ...valid, SUPABASE_SERVICE_ROLE_KEY: "" }),
    ).toThrowError(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  it("parses and rejects Inngest env", () => {
    const valid = { INNGEST_EVENT_KEY: "evt", INNGEST_SIGNING_KEY: "signkey-test-123" };
    expect(parseEnv("inngest", inngestEnvSchema, valid)).toEqual(valid);
    expect(() => parseEnv("inngest", inngestEnvSchema, { INNGEST_EVENT_KEY: "evt" })).toThrowError(
      /INNGEST_SIGNING_KEY/,
    );
  });

  it("parses and rejects OpenAI env", () => {
    expect(parseEnv("openai", openAIEnvSchema, { OPENAI_API_KEY: "sk-test" })).toEqual({ OPENAI_API_KEY: "sk-test" });
    expect(() => parseEnv("openai", openAIEnvSchema, { OPENAI_API_KEY: "" })).toThrowError(/OPENAI_API_KEY/);
  });

  it("parses and rejects GitHub App env", () => {
    const valid = {
      GITHUB_APP_ID: "123456",
      GITHUB_APP_CLIENT_ID: "Iv1.abc",
      GITHUB_APP_CLIENT_SECRET: "secret",
      GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nMIIE...\\n-----END PRIVATE KEY-----\\n",
      GITHUB_APP_WEBHOOK_SECRET: "whsec",
    };
    expect(parseEnv("github app", githubAppEnvSchema, valid)).toEqual(valid);
    expect(() => parseEnv("github app", githubAppEnvSchema, { ...valid, GITHUB_APP_ID: "abc" })).toThrowError(
      /GITHUB_APP_ID/,
    );
  });

  it.each([
    ["PKCS#1", "-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----\n"],
    ["encrypted PKCS#8", "-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIE...\n-----END ENCRYPTED PRIVATE KEY-----\n"],
    ["truncated PKCS#8", "-----BEGIN PRIVATE KEY-----\nMIIE..."],
    ["empty", ""],
  ])("rejects a %s GitHub App private key", (_label, key) => {
    expect(() =>
      parseEnv("github app", githubAppEnvSchema, {
        GITHUB_APP_ID: "123456",
        GITHUB_APP_CLIENT_ID: "Iv1.abc",
        GITHUB_APP_CLIENT_SECRET: "secret",
        GITHUB_APP_PRIVATE_KEY: key,
        GITHUB_APP_WEBHOOK_SECRET: "whsec",
      }),
    ).toThrowError(/GITHUB_APP_PRIVATE_KEY/);
  });

  it("defaults the edge Sentry environment and rejects a non-url DSN", () => {
    expect(parseEnv("edge sentry", edgeSentryEnvSchema, { SENTRY_DSN: "https://k@o1.ingest.sentry.io/1" })).toEqual({
      SENTRY_DSN: "https://k@o1.ingest.sentry.io/1",
      SENTRY_ENVIRONMENT: "development",
    });
    expect(() => parseEnv("edge sentry", edgeSentryEnvSchema, { SENTRY_DSN: "nope" })).toThrowError(/SENTRY_DSN/);
  });
});
