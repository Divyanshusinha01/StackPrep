import type { Event } from "@sentry/deno";
import { assertEquals, assertStrictEquals } from "@std/assert";
import { apiErrorSchema } from "@stackprep/shared";
import { reportUnexpected, scrubEvent, type SentryReporter, withSentry } from "./sentry.ts";

interface FakeReporter extends SentryReporter {
  captured: { err: unknown; tags: Record<string, string | number> }[];
  flushes: number[];
}

function createFakeReporter(): FakeReporter {
  const captured: FakeReporter["captured"] = [];
  const flushes: number[] = [];
  return {
    captured,
    flushes,
    captureException(err, { tags }) {
      captured.push({ err, tags });
    },
    flush(timeoutMs) {
      flushes.push(timeoutMs);
      return Promise.resolve(true);
    },
  };
}

function silenceConsoleError(): () => void {
  const original = console.error;
  console.error = () => {};
  return () => {
    console.error = original;
  };
}

Deno.test("a thrown error is captured, flushed, and answered with a 500 internal_error", async () => {
  const reporter = createFakeReporter();
  const boom = new Error("boom");
  const handler = withSentry(() => {
    throw boom;
  }, { webOrigin: "http://localhost:3000/app", reporter });

  const restore = silenceConsoleError();
  let res: Response;
  try {
    res = await handler(new Request("http://localhost/fn"));
  } finally {
    restore();
  }

  assertEquals(res.status, 500);
  assertEquals(res.headers.get("access-control-allow-origin"), "http://localhost:3000");
  assertEquals(res.headers.get("cache-control"), "no-store");
  assertEquals(apiErrorSchema.parse(await res.json()), { error: "Internal error", code: "internal_error" });
  assertEquals(reporter.captured.length, 1);
  assertStrictEquals(reporter.captured[0].err, boom);
  assertEquals(reporter.flushes, [2000]);
});

Deno.test("a rejected promise is handled like a throw, without CORS when no web origin is given", async () => {
  const reporter = createFakeReporter();
  const handler = withSentry(() => Promise.reject(new Error("async boom")), { reporter });

  const restore = silenceConsoleError();
  let res: Response;
  try {
    res = await handler(new Request("http://localhost/fn"));
  } finally {
    restore();
  }

  assertEquals(res.status, 500);
  assertEquals(res.headers.get("access-control-allow-origin"), null);
  assertEquals(reporter.captured.length, 1);
});

Deno.test("returned responses, including 4xx and 5xx, pass through unchanged without a capture", async () => {
  const reporter = createFakeReporter();
  for (const status of [200, 404, 429, 502]) {
    const original = Response.json({ status }, { status });
    const res = await withSentry(() => original, { reporter })(new Request("http://localhost/fn"));
    assertStrictEquals(res, original);
  }
  assertEquals(reporter.captured, []);
  assertEquals(reporter.flushes, []);
});

Deno.test("a thrown error still gets the 500 when Sentry is disabled", async () => {
  const restore = silenceConsoleError();
  try {
    const res = await withSentry(() => {
      throw new Error("boom");
    }, { reporter: null })(new Request("http://localhost/fn"));
    assertEquals(res.status, 500);
  } finally {
    restore();
  }
});

Deno.test("reportUnexpected ignores expected codes", () => {
  const reporter = createFakeReporter();
  for (const code of ["unauthorized", "not_found", "rate_limited", "github_rate_limited", "realtime_unavailable"] as const) {
    reportUnexpected(new Error("expected"), { fn: "github", code }, reporter);
  }
  assertEquals(reporter.captured, []);
});

Deno.test("reportUnexpected captures internal failures with allow-listed tags only", () => {
  const reporter = createFakeReporter();
  const err = new Error("db down");
  const ctx = { fn: "workspaces", code: "internal_error", workspace_id: "w1", token: "secret" } as const;
  reportUnexpected(err, ctx, reporter);
  reportUnexpected(new Error("bad payload"), { fn: "github", code: "github_unexpected_response", installation_id: 7 }, reporter);
  reportUnexpected(new Error("no code"), { event: "ai_usage_record_failed" }, reporter);

  assertEquals(reporter.captured.map((c) => c.tags), [
    { fn: "workspaces", code: "internal_error", workspace_id: "w1" },
    { fn: "github", code: "github_unexpected_response", installation_id: 7 },
    { event: "ai_usage_record_failed" },
  ]);
  assertStrictEquals(reporter.captured[0].err, err);
});

Deno.test("reportUnexpected wraps non-Error values and is a no-op without a reporter", () => {
  const reporter = createFakeReporter();
  reportUnexpected(null, { event: "report_content_invalid", code: "internal_error" }, reporter);
  const captured = reporter.captured[0].err;
  assertEquals(captured instanceof Error && captured.message, "report_content_invalid");

  reportUnexpected(new Error("ignored"), { code: "internal_error" }, null);
});

Deno.test("scrubEvent keeps only the method and a query-less URL", () => {
  const event = scrubEvent<Event>({
    request: {
      method: "POST",
      url: "https://x.supabase.co/functions/v1/github?code=secret",
      headers: { authorization: "Bearer t" },
      cookies: { sb: "t" },
      query_string: "code=secret",
      data: { token: "t" },
    },
  });
  assertEquals(event.request, { method: "POST", url: "https://x.supabase.co/functions/v1/github" });
});
