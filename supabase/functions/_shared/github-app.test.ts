import { assert, assertEquals, assertInstanceOf, assertRejects } from "@std/assert";
import {
  classifyResponse,
  createGithubApp,
  type GithubAppOptions,
  GithubError,
  GithubForbiddenError,
  type GithubInstallation,
  GithubNotFoundError,
  GithubOAuthCodeError,
  GithubRateLimitedError,
  GithubUnavailableError,
  GithubUnexpectedResponseError,
} from "./github-app.ts";

const APP_ID = 1234;
const START = Date.parse("2026-10-04T00:00:00Z");

const keyPair = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
);
const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey));
const pkcs8Base64 = btoa(String.fromCharCode(...pkcs8)).match(/.{1,64}/g)!.join("\\n");
// Escaped newlines, as stored in env files.
const privateKeyPem = `-----BEGIN PRIVATE KEY-----\\n${pkcs8Base64}\\n-----END PRIVATE KEY-----\\n`;

type Route = (req: Request, url: URL) => Response | Promise<Response>;

function setup(routes: Record<string, Route>, options: Partial<GithubAppOptions> = {}) {
  const calls: { key: string; req: Request }[] = [];
  const clock = { now: START };
  const revokeFailures: GithubError[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const key = `${req.method} ${url.pathname}`;
    calls.push({ key, req });
    const route = routes[key] ?? (key.startsWith("DELETE /applications/") ? routes["DELETE revoke"] : undefined);
    if (route) {
      return await route(req, url);
    }
    if (key.startsWith("DELETE /applications/")) {
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request ${key}`);
  };
  const app = createGithubApp({
    appId: String(APP_ID),
    clientId: "Iv1.client",
    clientSecret: "client-secret-value",
    privateKeyPem,
    fetch,
    now: () => clock.now,
    onRevokeFailure: (err) => revokeFailures.push(err),
    ...options,
  });
  const count = (key: string) => calls.filter((c) => c.key === key).length;
  return { app, calls, clock, count, revokeFailures };
}

const json = (body: unknown, init: ResponseInit = {}) => Response.json(body, init);

const oauthOk: Route = () => json({ access_token: "ghu_usertoken", token_type: "bearer", scope: "" });
const userOk: Route = () => json({ id: 99, login: "alice" });
const installationsPage = (installations: { id: number; app_id: number }[]): Route => () =>
  json({ total_count: installations.length, installations });

const OAUTH = "POST /login/oauth/access_token";
const USER = "GET /user";
const USER_INSTALLATIONS = "GET /user/installations";
const MINT = (id: number) => `POST /app/installations/${id}/access_tokens`;
const REPOS = "GET /installation/repositories";

function mintOk(clock: { now: number }, token = "ghs_installation", ttlMs = 3_600_000): Route {
  return () => json({ token, expires_at: new Date(clock.now + ttlMs).toISOString() });
}

function repo(id: number, fullName = `alice/repo-${id}`) {
  const [owner, name] = fullName.split("/");
  return {
    id,
    name,
    full_name: fullName,
    private: false,
    default_branch: "main",
    html_url: `https://github.com/${fullName}`,
    owner: { login: owner },
    node_id: "extra-field",
  };
}

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(atob(segment.replaceAll("-", "+").replaceAll("_", "/")));
}

// App JWT -----------------------------------------------------------------------

Deno.test("App JWT has the expected header, claims, and a valid signature", async () => {
  const { app } = setup({});
  const jwt = await app._internal.createAppJwt();
  const [header, payload, signature] = jwt.split(".");
  assertEquals(decodeSegment(header), { alg: "RS256", typ: "JWT" });
  const iat = Math.floor(START / 1000) - 60;
  assertEquals(decodeSegment(payload), { iat, exp: iat + 600, iss: String(APP_ID) });
  const sig = Uint8Array.from(atob(signature.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    keyPair.publicKey,
    sig,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  assert(valid);
});

// OAuth + user installation check ------------------------------------------------

Deno.test("verifyUserInstallation exchanges the code, checks installations, and revokes the token", async () => {
  let oauthBody = "";
  let revoke: Request | undefined;
  const { app, revokeFailures } = setup({
    [OAUTH]: async (req) => {
      oauthBody = await req.text();
      assertEquals(req.headers.get("accept"), "application/json");
      return oauthOk(req, new URL(req.url));
    },
    [USER]: (req) => {
      assertEquals(req.headers.get("authorization"), "Bearer ghu_usertoken");
      assertEquals(req.headers.get("x-github-api-version"), "2022-11-28");
      assertEquals(req.headers.get("user-agent"), "stackprep");
      return json({ id: 99, login: "alice" });
    },
    [USER_INSTALLATIONS]: installationsPage([{ id: 7, app_id: APP_ID }]),
    "DELETE revoke": (req) => {
      revoke = req;
      return new Response(null, { status: 204 });
    },
  });
  const result = await app.verifyUserInstallation("the-code", 7);
  assertEquals(result, { githubUserId: 99, githubLogin: "alice", hasInstallation: true });
  const form = new URLSearchParams(oauthBody);
  assertEquals(form.get("client_id"), "Iv1.client");
  assertEquals(form.get("client_secret"), "client-secret-value");
  assertEquals(form.get("code"), "the-code");
  assert(revoke);
  assertEquals(new URL(revoke.url).pathname, "/applications/Iv1.client/token");
  assertEquals(revoke.headers.get("authorization"), `Basic ${btoa("Iv1.client:client-secret-value")}`);
  assertEquals(await revoke.json(), { access_token: "ghu_usertoken" });
  assertEquals(revokeFailures, []);
});

Deno.test("bad_verification_code throws GithubOAuthCodeError", async () => {
  const { app, count } = setup({
    [OAUTH]: () => json({ error: "bad_verification_code", error_description: "expired" }),
  });
  await assertRejects(() => app.verifyUserInstallation("code", 7), GithubOAuthCodeError);
  assertEquals(count(USER), 0);
});

for (
  const [label, route] of [
    ["another OAuth error", () => json({ error: "incorrect_client_credentials" })],
    ["missing access_token", () => json({ token_type: "bearer" })],
    ["non-bearer token_type", () => json({ access_token: "ghu_x", token_type: "mac" })],
    ["non-JSON body", () => new Response("not json", { status: 200 })],
    ["HTML body", () => new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } })],
    ["unexpected status", () => json({}, { status: 401 })],
  ] as [string, Route][]
) {
  Deno.test(`OAuth exchange with ${label} throws GithubUnexpectedResponseError`, async () => {
    const { app } = setup({ [OAUTH]: route });
    await assertRejects(() => app.verifyUserInstallation("code", 7), GithubUnexpectedResponseError);
  });
}

for (
  const [label, body] of [
    ["missing id", { login: "alice" }],
    ["string id", { id: "99", login: "alice" }],
  ] as [string, unknown][]
) {
  Deno.test(`malformed /user (${label}) is rejected and the token is still revoked`, async () => {
    const { app, count } = setup({ [OAUTH]: oauthOk, [USER]: () => json(body) });
    await assertRejects(() => app.verifyUserInstallation("code", 7), GithubUnexpectedResponseError);
    assertEquals(count("DELETE /applications/Iv1.client/token"), 1);
  });
}

Deno.test("user installation paging stops at a short page", async () => {
  const full = Array.from({ length: 100 }, (_, i) => ({ id: 1000 + i, app_id: APP_ID }));
  const { app, count } = setup({
    [OAUTH]: oauthOk,
    [USER]: userOk,
    [USER_INSTALLATIONS]: (_req, url) =>
      json({ total_count: 103, installations: url.searchParams.get("page") === "1" ? full : full.slice(0, 3) }),
  });
  const result = await app.verifyUserInstallation("code", 7);
  assertEquals(result.hasInstallation, false);
  assertEquals(count(USER_INSTALLATIONS), 2);
});

Deno.test("user installation paging stops after page 10", async () => {
  const full = Array.from({ length: 100 }, (_, i) => ({ id: 1000 + i, app_id: APP_ID }));
  const { app, count } = setup({
    [OAUTH]: oauthOk,
    [USER]: userOk,
    [USER_INSTALLATIONS]: () => json({ total_count: 5000, installations: full }),
  });
  assertEquals((await app.verifyUserInstallation("code", 7)).hasInstallation, false);
  assertEquals(count(USER_INSTALLATIONS), 10);
});

Deno.test("an installation of another App is not a match", async () => {
  const { app } = setup({
    [OAUTH]: oauthOk,
    [USER]: userOk,
    [USER_INSTALLATIONS]: installationsPage([{ id: 7, app_id: APP_ID + 1 }, { id: 8, app_id: APP_ID }]),
  });
  assertEquals((await app.verifyUserInstallation("code", 7)).hasInstallation, false);
});

Deno.test("user token is revoked when the installation lookup fails", async () => {
  const { app, count } = setup({
    [OAUTH]: oauthOk,
    [USER]: userOk,
    [USER_INSTALLATIONS]: () => json({}, { status: 502 }),
  });
  await assertRejects(() => app.verifyUserInstallation("code", 7), GithubUnavailableError);
  assertEquals(count("DELETE /applications/Iv1.client/token"), 1);
});

Deno.test("revoke failure is reported without the token and does not change the result", async () => {
  for (
    const revokeRoute of [
      () => json({ message: "boom" }, { status: 500, headers: { "x-github-request-id": "REQ1" } }),
      () => Promise.reject(new TypeError("network down")),
    ] as Route[]
  ) {
    const { app, revokeFailures } = setup({
      [OAUTH]: oauthOk,
      [USER]: userOk,
      [USER_INSTALLATIONS]: installationsPage([{ id: 7, app_id: APP_ID }]),
      "DELETE revoke": revokeRoute,
    });
    assertEquals((await app.verifyUserInstallation("code", 7)).hasInstallation, true);
    assertEquals(revokeFailures.length, 1);
    assertInstanceOf(revokeFailures[0], GithubError);
    assert(!JSON.stringify({ ...revokeFailures[0], message: revokeFailures[0].message }).includes("ghu_"));
  }
});

// Status mapping ------------------------------------------------------------------

function classify(status: number, headers: Record<string, string> = {}) {
  return classifyResponse(new Response(null, { status, headers }), START);
}

Deno.test("classifyResponse maps statuses to typed errors", () => {
  assertInstanceOf(classify(403), GithubForbiddenError);
  assertInstanceOf(classify(404), GithubNotFoundError);
  assertInstanceOf(classify(500), GithubUnavailableError);
  assertInstanceOf(classify(503), GithubUnavailableError);
  assertInstanceOf(classify(401), GithubUnexpectedResponseError);
  assertInstanceOf(classify(422), GithubUnexpectedResponseError);
  assertInstanceOf(classify(304), GithubUnexpectedResponseError);
  const withId = classify(404, { "x-github-request-id": "ABC" });
  assertEquals([withId.status, withId.requestId], [404, "ABC"]);
});

Deno.test("classifyResponse detects rate limiting and computes Retry-After", () => {
  const remaining = classify(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(START / 1000 + 120) });
  assertInstanceOf(remaining, GithubRateLimitedError);
  assertEquals(remaining.retryAfterSeconds, 120);

  const secondary = classify(403, { "retry-after": "30" });
  assertInstanceOf(secondary, GithubRateLimitedError);
  assertEquals(secondary.retryAfterSeconds, 30);

  const tooMany = classify(429, { "retry-after": "5" });
  assertInstanceOf(tooMany, GithubRateLimitedError);
  assertEquals(tooMany.retryAfterSeconds, 5);

  assertEquals((classify(429) as GithubRateLimitedError).retryAfterSeconds, 60);
  assertEquals((classify(429, { "retry-after": "999999" }) as GithubRateLimitedError).retryAfterSeconds, 3600);
  assertEquals((classify(429, { "retry-after": "0" }) as GithubRateLimitedError).retryAfterSeconds, 1);
  assertEquals(
    (classify(429, { "x-ratelimit-reset": String(START / 1000 - 50) }) as GithubRateLimitedError).retryAfterSeconds,
    1,
  );
  assertEquals((classify(429, { "retry-after": "soon" }) as GithubRateLimitedError).retryAfterSeconds, 60);
});

Deno.test("fetch rejection and timeouts map to GithubUnavailableError", async () => {
  for (const error of [new TypeError("dns"), new DOMException("timed out", "TimeoutError")]) {
    const { app } = setup({ "GET /app/installations/7": () => Promise.reject(error) });
    await assertRejects(() => app.getInstallation(7), GithubUnavailableError);
  }
});

Deno.test("getInstallation authenticates with the App JWT and validates the response", async () => {
  const installation: GithubInstallation = {
    id: 7,
    app_id: APP_ID,
    account: { id: 1, login: "acme", type: "Organization" },
    repository_selection: "selected",
    permissions: { metadata: "read", contents: "read" },
    suspended_at: null,
  };
  const { app } = setup({
    "GET /app/installations/7": (req) => {
      assert(req.headers.get("authorization")?.startsWith("Bearer ey"));
      return json({ ...installation, access_tokens_url: "x" });
    },
    "GET /app/installations/8": () => json({ ...installation, id: 8, repository_selection: "some" }),
  });
  assertEquals(await app.getInstallation(7), installation);
  await assertRejects(() => app.getInstallation(8), GithubUnexpectedResponseError);
});

// Installation token cache --------------------------------------------------------

Deno.test("installation tokens are cached until five minutes before expiry", async () => {
  let n = 0;
  const { app, clock, count } = setup({
    [MINT(7)]: (req, url) => mintOk(clock, `ghs_token${++n}`)(req, url),
  });
  assertEquals(await app._internal.getInstallationToken(7), "ghs_token1");
  clock.now += 54 * 60_000;
  assertEquals(await app._internal.getInstallationToken(7), "ghs_token1");
  assertEquals(count(MINT(7)), 1);
  clock.now += 60_000; // exactly 5 minutes left
  assertEquals(await app._internal.getInstallationToken(7), "ghs_token2");
  clock.now += 2 * 3_600_000; // expired
  assertEquals(await app._internal.getInstallationToken(7), "ghs_token3");
  assertEquals(count(MINT(7)), 3);
});

Deno.test("a failed mint is not cached", async () => {
  let fail = true;
  const { app, clock, count } = setup({
    [MINT(7)]: (req, url) => (fail ? json({}, { status: 502 }) : mintOk(clock)(req, url)),
  });
  await assertRejects(() => app._internal.getInstallationToken(7), GithubUnavailableError);
  fail = false;
  assertEquals(await app._internal.getInstallationToken(7), "ghs_installation");
  assertEquals(count(MINT(7)), 2);
});

Deno.test("a 401 with an installation token evicts the cached token", async () => {
  let n = 0;
  let unauthorized = true;
  const { app, clock, count } = setup({
    [MINT(7)]: (req, url) => mintOk(clock, `ghs_token${++n}`)(req, url),
    [REPOS]: () => (unauthorized ? json({}, { status: 401 }) : json({ total_count: 0, repositories: [] })),
  });
  await assertRejects(() => app.listAllInstallationRepositories(7), GithubUnexpectedResponseError);
  unauthorized = false;
  await app.listAllInstallationRepositories(7);
  assertEquals(count(MINT(7)), 2);
});

Deno.test("concurrent token requests share one mint per installation", async () => {
  const gates: (() => void)[] = [];
  const { app, clock, count } = setup({
    [MINT(7)]: async (req, url) => {
      await new Promise<void>((resolve) => gates.push(resolve));
      return mintOk(clock, "ghs_seven")(req, url);
    },
    [MINT(8)]: async (req, url) => {
      await new Promise<void>((resolve) => gates.push(resolve));
      return mintOk(clock, "ghs_eight")(req, url);
    },
  });
  const pending = Promise.all([
    app._internal.getInstallationToken(7),
    app._internal.getInstallationToken(7),
    app._internal.getInstallationToken(8),
    app._internal.getInstallationToken(7),
  ]);
  while (gates.length < 2) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  gates.forEach((release) => release());
  assertEquals(await pending, ["ghs_seven", "ghs_seven", "ghs_eight", "ghs_seven"]);
  assertEquals(count(MINT(7)), 1);
  assertEquals(count(MINT(8)), 1);
});

// Repository paging ---------------------------------------------------------------

function reposRoute(total: number, pageSize = (page: number) => Math.max(0, Math.min(100, total - (page - 1) * 100))) {
  return (_req: Request, url: URL) => {
    const page = Number(url.searchParams.get("page"));
    const size = pageSize(page);
    const start = (page - 1) * 100;
    return json({ total_count: total, repositories: Array.from({ length: size }, (_, i) => repo(start + i + 1)) });
  };
}

Deno.test("repository paging stops once total_count is reached", async () => {
  const { app, clock, count } = setup({ [MINT(7)]: (req, url) => mintOk(clock)(req, url), [REPOS]: reposRoute(150) });
  const result = await app.listAllInstallationRepositories(7);
  assertEquals(result.repositories.length, 150);
  assertEquals(result.truncated, false);
  assertEquals(count(REPOS), 2);
  assertEquals(Object.keys(result.repositories[0]).includes("node_id"), false);
});

Deno.test("repository paging stops at an empty page", async () => {
  const { app, clock, count } = setup({
    [MINT(7)]: (req, url) => mintOk(clock)(req, url),
    [REPOS]: reposRoute(500, (page) => (page === 1 ? 100 : 0)),
  });
  assertEquals((await app.listAllInstallationRepositories(7)).repositories.length, 100);
  assertEquals(count(REPOS), 2);
});

Deno.test("repository paging stops after page 10 and marks truncation", async () => {
  const { app, clock, count } = setup({ [MINT(7)]: (req, url) => mintOk(clock)(req, url), [REPOS]: reposRoute(1500) });
  const result = await app.listAllInstallationRepositories(7);
  assertEquals(result.repositories.length, 1000);
  assertEquals(result.truncated, true);
  assertEquals(count(REPOS), 10);
});

Deno.test("403/404 from minting surface as typed errors, but from listing are unexpected", async () => {
  for (const status of [403, 404]) {
    const mintFails = setup({ [MINT(7)]: () => json({}, { status }) });
    await assertRejects(
      () => mintFails.app.listAllInstallationRepositories(7),
      status === 403 ? GithubForbiddenError : GithubNotFoundError,
    );
    const { app, clock } = setup({
      [MINT(7)]: (req, url) => mintOk(clock)(req, url),
      [REPOS]: () => json({}, { status }),
    });
    const err = await assertRejects(() => app.listAllInstallationRepositories(7), GithubUnexpectedResponseError);
    assertEquals(err.status, status);
  }
});

// Repository head ----------------------------------------------------------------

const REPO = "GET /repos/alice/app";
const SHA = "0123456789abcdef0123456789abcdef01234567";

function headRoutes(clock: { now: number }, branch = "main"): Record<string, Route> {
  return {
    [MINT(7)]: (req, url) => mintOk(clock)(req, url),
    [REPO]: (req) => {
      assertEquals(req.headers.get("authorization"), "Bearer ghs_installation");
      return json({ ...repo(1, "alice/app"), default_branch: branch });
    },
    [`GET /repos/alice/app/branches/${encodeURIComponent(branch)}`]: (req) => {
      assertEquals(req.headers.get("authorization"), "Bearer ghs_installation");
      return json({ name: branch, commit: { sha: SHA, url: "x" }, protected: false });
    },
  };
}

Deno.test("getRepositoryHead returns the default branch and its head commit", async () => {
  const clock = { now: START };
  const { app, calls } = setup(headRoutes(clock), { now: () => clock.now });
  assertEquals(await app.getRepositoryHead(7, "alice", "app"), { defaultBranch: "main", commitSha: SHA });
  assertEquals(calls.map((c) => c.key), [MINT(7), REPO, "GET /repos/alice/app/branches/main"]);
});

Deno.test("getRepositoryHead encodes branch names with slashes", async () => {
  const clock = { now: START };
  const { app } = setup(headRoutes(clock, "release/v1"), { now: () => clock.now });
  assertEquals((await app.getRepositoryHead(7, "alice", "app")).defaultBranch, "release/v1");
});

Deno.test("getRepositoryHead rejects a malformed commit sha", async () => {
  const clock = { now: START };
  const { app } = setup(
    {
      ...headRoutes(clock),
      "GET /repos/alice/app/branches/main": () => json({ name: "main", commit: { sha: "not-a-sha" } }),
    },
    { now: () => clock.now },
  );
  await assertRejects(() => app.getRepositoryHead(7, "alice", "app"), GithubUnexpectedResponseError);
});

Deno.test("getRepositoryHead: 403/404 from minting are typed, from reads are unexpected", async () => {
  for (const status of [403, 404]) {
    const mintFails = setup({ [MINT(7)]: () => json({}, { status }) });
    await assertRejects(
      () => mintFails.app.getRepositoryHead(7, "alice", "app"),
      status === 403 ? GithubForbiddenError : GithubNotFoundError,
    );
    for (const failing of [REPO, "GET /repos/alice/app/branches/main"]) {
      const clock = { now: START };
      const { app } = setup({ ...headRoutes(clock), [failing]: () => json({}, { status }) }, { now: () => clock.now });
      const err = await assertRejects(() => app.getRepositoryHead(7, "alice", "app"), GithubUnexpectedResponseError);
      assertEquals(err.status, status);
    }
  }
});

Deno.test("getRepositoryHead maps rate limits and 5xx, and evicts the token on 401", async () => {
  const clock = { now: START };
  const limited = setup(
    { ...headRoutes(clock), [REPO]: () => json({}, { status: 429, headers: { "retry-after": "12" } }) },
    { now: () => clock.now },
  );
  const err = await assertRejects(() => limited.app.getRepositoryHead(7, "alice", "app"), GithubRateLimitedError);
  assertEquals(err.retryAfterSeconds, 12);

  const down = setup({ ...headRoutes(clock), [REPO]: () => json({}, { status: 502 }) }, { now: () => clock.now });
  await assertRejects(() => down.app.getRepositoryHead(7, "alice", "app"), GithubUnavailableError);

  let unauthorized = true;
  const routes = headRoutes(clock);
  const evicting = setup(
    { ...routes, [REPO]: (req, url) => (unauthorized ? json({}, { status: 401 }) : routes[REPO](req, url)) },
    { now: () => clock.now },
  );
  await assertRejects(() => evicting.app.getRepositoryHead(7, "alice", "app"), GithubUnexpectedResponseError);
  unauthorized = false;
  await evicting.app.getRepositoryHead(7, "alice", "app");
  assertEquals(evicting.count(MINT(7)), 2);
});

Deno.test("a malformed repository entry is rejected", async () => {
  const { app, clock } = setup({
    [MINT(7)]: (req, url) => mintOk(clock)(req, url),
    [REPOS]: () => json({ total_count: 1, repositories: [{ ...repo(1), private: "no" }] }),
  });
  await assertRejects(() => app.listAllInstallationRepositories(7), GithubUnexpectedResponseError);
});
