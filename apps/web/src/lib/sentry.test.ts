import type { ErrorEvent } from "@sentry/nextjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scrubBreadcrumb, scrubEvent, sentryOptions } from "./sentry";

describe("sentryOptions", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("disables Sentry when the DSN is empty or missing", () => {
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "");
    expect(sentryOptions()).toBeNull();
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", undefined);
    expect(sentryOptions()).toBeNull();
  });

  it("builds options without PII when the DSN is set", () => {
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "https://key@o1.ingest.sentry.io/1");
    expect(sentryOptions()).toMatchObject({
      dsn: "https://key@o1.ingest.sentry.io/1",
      dataCollection: { userInfo: false, cookies: false, httpBodies: [], urlQueryParams: false },
      tracesSampleRate: 0.1,
    });
  });

  it("rejects a malformed DSN", () => {
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "not-a-url");
    expect(() => sentryOptions()).toThrow(/web Sentry/);
  });
});

describe("scrubEvent", () => {
  it("drops cookies, bodies, query strings and auth headers", () => {
    const event: ErrorEvent = {
      type: undefined,
      request: {
        url: "https://app.test/auth/callback?code=secret",
        query_string: "code=secret",
        cookies: { "sb-access-token": "t" },
        data: { password: "p" },
        headers: { Authorization: "Bearer t", cookie: "a=b", "user-agent": "ua" },
      },
    };
    expect(scrubEvent(event).request).toEqual({
      url: "https://app.test/auth/callback",
      headers: { "user-agent": "ua" },
    });
  });

  it("strips the query string from the Next.js request path context", () => {
    const event: ErrorEvent = {
      type: undefined,
      contexts: { nextjs: { request_path: "/github/callback?code=secret", router_path: "/github/callback" } },
    };
    expect(scrubEvent(event).contexts?.nextjs).toEqual({
      request_path: "/github/callback",
      router_path: "/github/callback",
    });
  });
});

describe("scrubBreadcrumb", () => {
  it("strips query strings from navigation and fetch URLs", () => {
    expect(scrubBreadcrumb({ data: { from: "/a?x=1", to: "/github/callback?code=c", method: "GET" } }).data).toEqual({
      from: "/a",
      to: "/github/callback",
      method: "GET",
    });
  });

  it("redacts OpenAI secret keys from breadcrumb messages and data", () => {
    const key = "sk-proj-abcdefghijklmnopqrstuvwxyz0123";
    const crumb = scrubBreadcrumb({ message: `console ${key}`, data: { arguments: [key] } });
    expect(JSON.stringify(crumb)).not.toContain(key);
    expect(crumb.message).toBe("console sk-[redacted]");
  });
});

describe("scrubEvent key redaction", () => {
  it("redacts OpenAI secret keys from exception values but keeps hints", () => {
    const key = "sk-proj-abcdefghijklmnopqrstuvwxyz0123";
    const event = scrubEvent({
      type: undefined,
      message: "hint sk-...0123",
      exception: { values: [{ type: "Error", value: `bad ${key}` }] },
    } as ErrorEvent);
    expect(JSON.stringify(event)).not.toContain(key);
    expect(event.message).toBe("hint sk-...0123");
  });
});
