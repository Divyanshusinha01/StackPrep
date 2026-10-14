import { describe, expect, it } from "vitest";
import { buildFullCsp, sentryReportUri } from "./csp";

describe("sentryReportUri", () => {
  it("derives the security endpoint from a DSN", () => {
    expect(sentryReportUri("https://abc123@o42.ingest.us.sentry.io/7")).toBe(
      "https://o42.ingest.us.sentry.io/api/7/security/?sentry_key=abc123",
    );
  });

  it("returns null for a missing or malformed DSN", () => {
    expect(sentryReportUri(undefined)).toBeNull();
    expect(sentryReportUri("")).toBeNull();
    expect(sentryReportUri("not a url")).toBeNull();
    expect(sentryReportUri("https://o42.ingest.sentry.io/7")).toBeNull();
  });
});

describe("buildFullCsp", () => {
  it("allows the Supabase, OpenAI and Sentry origins the browser talks to", () => {
    const csp = buildFullCsp({
      supabaseUrl: "https://ref.supabase.co",
      sentryDsn: "https://abc@o1.ingest.sentry.io/2",
      dev: false,
    });
    const connect = csp.split("; ").find((d) => d.startsWith("connect-src "));
    expect(connect).toBe(
      "connect-src 'self' https://api.openai.com https://ref.supabase.co wss://ref.supabase.co https://o1.ingest.sentry.io",
    );
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("report-uri https://o1.ingest.sentry.io/api/2/security/?sentry_key=abc");
    expect(csp).not.toContain("unsafe-eval");
  });

  it("allows eval and dev websockets only in development", () => {
    const csp = buildFullCsp({ supabaseUrl: "http://127.0.0.1:54321", sentryDsn: undefined, dev: true });
    expect(csp).toContain("'unsafe-eval'");
    expect(csp).toContain("ws://127.0.0.1:54321");
    expect(csp).not.toContain("report-uri");
  });
});
