import { assertEquals } from "@std/assert";
import { apiErrorSchema } from "@stackprep/shared";
import {
  GithubError,
  GithubForbiddenError,
  GithubNotFoundError,
  GithubOAuthCodeError,
  GithubRateLimitedError,
  GithubUnavailableError,
  GithubUnexpectedResponseError,
} from "./github-app.ts";
import { apiError, githubErrorResponse, logGithubError } from "./github-errors.ts";
import { createCors } from "./http.ts";

const cors = createCors("http://localhost:3000", ["GET"]);

Deno.test("typed GitHub errors map to their status and code", async () => {
  const cases: [unknown, number, string][] = [
    [new GithubOAuthCodeError(), 400, "invalid_oauth_code"],
    [new GithubRateLimitedError(42), 503, "github_rate_limited"],
    [new GithubUnavailableError({ status: 502 }), 502, "github_unavailable"],
    [new GithubForbiddenError({ status: 403 }), 502, "github_unexpected_response"],
    [new GithubNotFoundError({ status: 404 }), 502, "github_unexpected_response"],
    [new GithubUnexpectedResponseError({ status: 401 }), 502, "github_unexpected_response"],
    [new Error("db exploded: secret detail"), 500, "internal_error"],
  ];
  for (const [err, status, code] of cases) {
    const res = githubErrorResponse(err, cors);
    assertEquals(res.status, status);
    assertEquals(res.headers.get("cache-control"), "no-store");
    assertEquals(res.headers.get("access-control-allow-origin"), "http://localhost:3000");
    const body = apiErrorSchema.parse(await res.json());
    assertEquals(body.code, code);
    assertEquals(Object.keys(body).sort(), ["code", "error"]);
  }
});

Deno.test("rate limit responses carry Retry-After", () => {
  const res = githubErrorResponse(new GithubRateLimitedError(42), cors);
  assertEquals(res.headers.get("retry-after"), "42");
  assertEquals(githubErrorResponse(new GithubUnavailableError(), cors).headers.get("retry-after"), null);
});

Deno.test("apiError uses the status defined for each code", async () => {
  const cases: [Parameters<typeof apiError>[0], number][] = [
    ["method_not_allowed", 405],
    ["not_found", 404],
    ["invalid_request", 400],
    ["unauthorized", 401],
    ["github_account_mismatch", 403],
    ["installation_not_accessible", 403],
    ["unsupported_installation_account", 422],
    ["installation_suspended", 409],
    ["connection_not_found", 404],
    ["interview_not_found", 404],
    ["interview_preparing", 409],
    ["interview_planning_failed", 409],
    ["interview_not_active", 409],
    ["realtime_unavailable", 502],
    ["event_conflict", 409],
  ];
  for (const [code, status] of cases) {
    const res = apiError(code, cors);
    assertEquals(res.status, status);
    assertEquals((await res.json()).code, code);
  }
});

function captureLogs(run: () => void): string[] {
  const lines: string[] = [];
  const original = console.error;
  console.error = (line: string) => lines.push(line);
  try {
    run();
  } finally {
    console.error = original;
  }
  return lines;
}

Deno.test("log lines contain only allow-listed keys", () => {
  const lines = captureLogs(() => {
    logGithubError("repositories", new GithubNotFoundError({ status: 404, requestId: "REQ-1" }), {
      installation_id: 7,
      connection_id: "aaaaaaaa-0000-4000-8000-000000000001",
    });
    logGithubError("github", new Error("ghu_secret token in message"));
    logGithubError("github", new GithubError("x"), { event: "github_token_revoke_failed" });
  });
  const allowed = new Set([
    "event",
    "fn",
    "code",
    "github_status",
    "github_request_id",
    "installation_id",
    "connection_id",
  ]);
  for (const line of lines) {
    for (const key of Object.keys(JSON.parse(line))) {
      assertEquals(allowed.has(key), true, `unexpected log key ${key}`);
    }
    assertEquals(line.includes("ghu_"), false);
  }
  assertEquals(JSON.parse(lines[0]), {
    event: "github_request_failed",
    fn: "repositories",
    code: "github_unexpected_response",
    github_status: 404,
    github_request_id: "REQ-1",
    installation_id: 7,
    connection_id: "aaaaaaaa-0000-4000-8000-000000000001",
  });
  assertEquals(JSON.parse(lines[1]), { event: "github_request_failed", fn: "github", code: "internal_error" });
  assertEquals(JSON.parse(lines[2]).event, "github_token_revoke_failed");
});
