import { describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";
import {
  byokEnvSchema,
  edgeEnvSchema,
  edgeSentryEnvSchema,
  edgeSupabaseEnvSchema,
  githubAppEnvSchema,
  inngestEnvSchema,
  openAIModelEnvSchema,
  parseEncryptionKeyring,
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

  it("accepts an optional site url for web and rejects a non-http one", () => {
    const withSite = { ...validWeb, NEXT_PUBLIC_SITE_URL: "https://stackprep.dev" };
    expect(parseEnv("web", webEnvSchema, withSite)).toEqual(withSite);
    expect(() =>
      parseEnv("web", webEnvSchema, { ...validWeb, NEXT_PUBLIC_SITE_URL: "stackprep.dev" }),
    ).toThrowError(/NEXT_PUBLIC_SITE_URL/);
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

  it("parses and rejects OpenAI model env, which carries no API key", () => {
    expect(parseEnv("openai", openAIModelEnvSchema, {})).toEqual({
      OPENAI_PLANNING_MODEL: "gpt-6.1-sol",
      OPENAI_EVALUATION_MODEL: "gpt-6-luna",
      OPENAI_REALTIME_MODEL: "gpt-realtime-2.1-mini",
      OPENAI_REALTIME_TRANSCRIPTION_MODEL: "gpt-live-transcribe",
      OPENAI_VISION_MODEL: "gpt-6-luna",
      OPENAI_EMBEDDING_MODEL: "text-embedding-3-small",
      OPENAI_REPORT_MODEL: "gpt-6-luna",
      OPENAI_PLANNING_REASONING_EFFORT: "medium",
      OPENAI_EVALUATION_REASONING_EFFORT: "low",
      OPENAI_REPORT_REASONING_EFFORT: "low",
      OPENAI_VISION_REASONING_EFFORT: "low",
    });
    expect(parseEnv("openai", openAIModelEnvSchema, { OPENAI_VISION_MODEL: "gpt-vision" }).OPENAI_VISION_MODEL).toBe(
      "gpt-vision",
    );
    expect(() => parseEnv("openai", openAIModelEnvSchema, { OPENAI_REALTIME_MODEL: "" })).toThrowError(
      /OPENAI_REALTIME_MODEL/,
    );
    expect(
      parseEnv("openai", openAIModelEnvSchema, { OPENAI_PLANNING_MODEL: "gpt-custom" }).OPENAI_PLANNING_MODEL,
    ).toBe("gpt-custom");
    expect(() => parseEnv("openai", openAIModelEnvSchema, { OPENAI_PLANNING_MODEL: " " })).toThrowError(
      /OPENAI_PLANNING_MODEL/,
    );
    expect("OPENAI_API_KEY" in openAIModelEnvSchema.shape).toBe(false);
  });

  it("accepts per-task reasoning effort and rejects unknown values", () => {
    expect(
      parseEnv("openai", openAIModelEnvSchema, { OPENAI_EVALUATION_REASONING_EFFORT: "default" })
        .OPENAI_EVALUATION_REASONING_EFFORT,
    ).toBe("default");
    expect(() => parseEnv("openai", openAIModelEnvSchema, { OPENAI_PLANNING_REASONING_EFFORT: "max" })).toThrowError(
      /OPENAI_PLANNING_REASONING_EFFORT/,
    );
  });

  it("defaults the embedding model and rejects an empty one", () => {
    expect(parseEnv("openai", openAIModelEnvSchema, {}).OPENAI_EMBEDDING_MODEL).toBe("text-embedding-3-small");
    expect(
      parseEnv("openai", openAIModelEnvSchema, { OPENAI_EMBEDDING_MODEL: "embed-custom" }).OPENAI_EMBEDDING_MODEL,
    ).toBe("embed-custom");
    expect(() => parseEnv("openai", openAIModelEnvSchema, { OPENAI_EMBEDDING_MODEL: "" })).toThrowError(
      /OPENAI_EMBEDDING_MODEL/,
    );
  });

  const key1 = Buffer.alloc(32, 1).toString("base64");
  const key2 = Buffer.alloc(32, 2).toString("base64");

  it("parses a versioned BYOK keyring", () => {
    expect(
      parseEnv("byok", byokEnvSchema, {
        OPENAI_KEY_ENCRYPTION_KEYS: `1:${key1},2:${key2}`,
        OPENAI_KEY_ENCRYPTION_ACTIVE_VERSION: "2",
      }),
    ).toEqual({ OPENAI_KEY_ENCRYPTION_KEYS: `1:${key1},2:${key2}`, OPENAI_KEY_ENCRYPTION_ACTIVE_VERSION: 2 });
    expect(parseEncryptionKeyring(`1:${key1}, 2:${key2}`)).toEqual(new Map([[1, key1], [2, key2]]));
  });

  it.each([
    ["missing", undefined],
    ["unversioned", key1],
    ["short", `1:${Buffer.alloc(16, 1).toString("base64")}`],
    ["not base64", "1:not-base64!"],
    ["duplicate versions", `1:${key1},1:${key2}`],
    ["version zero", `0:${key1}`],
  ])("rejects a %s BYOK keyring", (_label, keys) => {
    expect(() =>
      parseEnv("byok", byokEnvSchema, { OPENAI_KEY_ENCRYPTION_KEYS: keys, OPENAI_KEY_ENCRYPTION_ACTIVE_VERSION: "1" })
    ).toThrowError(/OPENAI_KEY_ENCRYPTION_KEYS/);
  });

  it("rejects a non-numeric active version", () => {
    expect(() =>
      parseEnv("byok", byokEnvSchema, {
        OPENAI_KEY_ENCRYPTION_KEYS: `1:${key1}`,
        OPENAI_KEY_ENCRYPTION_ACTIVE_VERSION: "latest",
      })
    ).toThrowError(/OPENAI_KEY_ENCRYPTION_ACTIVE_VERSION/);
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
