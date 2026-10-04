import { assert, assertEquals } from "@std/assert";
import { apiErrorSchema, type RepositoryListResponse, repositoryListResponseSchema } from "@stackprep/shared";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import type { Authenticate } from "../_shared/auth.ts";
import {
  type GithubApp,
  GithubForbiddenError,
  type GithubInstallation,
  GithubNotFoundError,
  GithubRateLimitedError,
  type GithubRepo,
  GithubUnavailableError,
  GithubUnexpectedResponseError,
  type InstallationRepositories,
} from "../_shared/github-app.ts";
import { assertNoSecrets } from "../_shared/testing.ts";
import { type ConnectionRow, createConnectionStateWriters, createRepositoriesHandler } from "./handler.ts";

const userId = "aaaaaaaa-0000-4000-8000-000000000001";
const webOrigin = "http://localhost:3000";
const CONN_A = "11111111-0000-4000-8000-000000000001";
const CONN_B = "22222222-0000-4000-8000-000000000002";
const OTHER_USERS_CONN = "33333333-0000-4000-8000-000000000003";

const connA: ConnectionRow = {
  id: CONN_A,
  installation_id: 1,
  account_login: "alice",
  suspended_at: null,
  created_at: "2026-10-01T00:00:00Z",
};
const connB: ConnectionRow = {
  id: CONN_B,
  installation_id: 2,
  account_login: "acme",
  suspended_at: null,
  created_at: "2026-10-02T00:00:00Z",
};

function repo(id: number, fullName: string, extra: Record<string, unknown> = {}): GithubRepo {
  const [owner, name] = fullName.split("/");
  return {
    id,
    name,
    full_name: fullName,
    private: id % 2 === 0,
    default_branch: "main",
    html_url: `https://github.com/${fullName}`,
    owner: { login: owner },
    ...extra,
  } as GithubRepo;
}

const installation = (id: number, suspended_at: string | null = null): GithubInstallation => ({
  id,
  app_id: 1234,
  account: { id, login: "x", type: "User" },
  repository_selection: "all",
  permissions: {},
  suspended_at,
});

interface InstallationBehaviour {
  list?: () => Promise<InstallationRepositories>;
  get?: () => Promise<GithubInstallation>;
}

interface Setup {
  rows?: ConnectionRow[];
  installations?: Record<number, InstallationBehaviour>;
  failWrites?: boolean;
  dbError?: boolean;
}

/** Mimics RLS: only rows passed in `rows` (the caller's) are ever visible. */
function fakeRlsClient(rows: ConnectionRow[], dbError: boolean) {
  const filters: [string, unknown][][] = [];
  const client = {
    from(table: string) {
      assertEquals(table, "github_connections");
      const applied: [string, unknown][] = [];
      filters.push(applied);
      const builder = {
        select: () => builder,
        order: () => builder,
        eq(column: string, value: unknown) {
          applied.push([column, value]);
          return builder;
        },
        then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
          const data = rows.filter((row) =>
            applied.every(([column, value]) => (row as unknown as Record<string, unknown>)[column] === value)
          );
          return Promise.resolve(dbError ? { data: null, error: { message: "boom" } } : { data, error: null }).then(
            resolve,
            reject,
          );
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient;
  return { client, filters };
}

function setup({ rows = [], installations = {}, failWrites = false, dbError = false }: Setup = {}) {
  const writes: string[] = [];
  const githubCalls: string[] = [];
  const rls = fakeRlsClient(rows, dbError);
  const authenticate: Authenticate = (req) =>
    Promise.resolve(
      req.headers.get("Authorization") === "Bearer valid"
        ? { user: { id: userId } as User, supabase: rls.client }
        : null,
    );
  const github: Pick<GithubApp, "getInstallation" | "listAllInstallationRepositories"> = {
    getInstallation(id) {
      githubCalls.push(`get:${id}`);
      return installations[id]?.get?.() ?? Promise.resolve(installation(id));
    },
    listAllInstallationRepositories(id) {
      githubCalls.push(`list:${id}`);
      return installations[id]?.list?.() ?? Promise.resolve({ repositories: [], truncated: false });
    },
  };
  const write = (name: string) => (connectionId: string, uid: string) => {
    writes.push(`${name}:${connectionId}`);
    assertEquals(uid, userId);
    return failWrites ? Promise.reject(new Error("db down")) : Promise.resolve();
  };
  const handler = createRepositoriesHandler({
    webOrigin,
    authenticate,
    github,
    markSuspended: write("markSuspended"),
    clearSuspended: write("clearSuspended"),
    deleteConnection: write("deleteConnection"),
  });
  return { handler, writes, githubCalls, filters: rls.filters };
}

function get(handler: (req: Request) => Promise<Response>, query = "", auth = "Bearer valid") {
  return handler(
    new Request(`http://localhost/repositories${query}`, { headers: { Authorization: auth, Origin: webOrigin } }),
  );
}

async function ok(res: Response): Promise<RepositoryListResponse> {
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("cache-control"), "no-store");
  await assertNoSecrets(res);
  return repositoryListResponseSchema.parse(await res.json());
}

async function expectError(res: Response, status: number, code: string) {
  assertEquals(res.status, status);
  assertEquals(res.headers.get("access-control-allow-origin"), webOrigin);
  await assertNoSecrets(res);
  assertEquals(apiErrorSchema.parse(await res.json()).code, code);
}

const listed = (repositories: GithubRepo[], truncated = false, delayMs = 0) => () =>
  new Promise<InstallationRepositories>((resolve) => setTimeout(() => resolve({ repositories, truncated }), delayMs));

let restoreConsole: () => void = () => {};
function quietConsole(): string[] {
  const lines: string[] = [];
  const original = console.error;
  console.error = (line: string) => lines.push(line);
  restoreConsole = () => (console.error = original);
  return lines;
}

// CORS / auth / validation --------------------------------------------------------

Deno.test("CORS, preflight, method, and auth checks", async () => {
  const { handler, githubCalls } = setup({ rows: [connA] });
  const foreign = await handler(
    new Request("http://localhost/repositories", {
      headers: { Origin: "https://evil.example", Authorization: "Bearer valid" },
    }),
  );
  assertEquals(foreign.status, 403);
  const preflight = await handler(
    new Request("http://localhost/repositories", { method: "OPTIONS", headers: { Origin: webOrigin } }),
  );
  assertEquals(preflight.status, 204);
  const post = await handler(
    new Request("http://localhost/repositories", { method: "POST", headers: { Authorization: "Bearer valid" } }),
  );
  assertEquals(post.headers.get("allow"), "GET, OPTIONS");
  await expectError(post, 405, "method_not_allowed");
  await expectError(await get(handler, "", ""), 401, "unauthorized");
  await expectError(await get(handler, "", "Bearer forged"), 401, "unauthorized");
  assertEquals(githubCalls, []);
});

Deno.test("invalid pagination and query parameters return 400", async () => {
  const { handler, githubCalls } = setup({ rows: [connA] });
  for (
    const query of [
      "?page=0",
      "?page=1001",
      "?page=abc",
      "?page=1.5",
      "?page=-1",
      "?per_page=0",
      "?per_page=101",
      "?page=1&page=2",
      "?foo=bar",
      "?connection_id=not-a-uuid",
    ]
  ) {
    await expectError(await get(handler, query), 400, "invalid_request");
  }
  assertEquals(githubCalls, []);
});

Deno.test("a database read error returns 500", async () => {
  quietConsole();
  try {
    const { handler } = setup({ dbError: true });
    await expectError(await get(handler), 500, "internal_error");
  } finally {
    restoreConsole();
  }
});

// Connection resolution -----------------------------------------------------------

Deno.test("no connections returns connected: false", async () => {
  const { handler } = setup();
  assertEquals(await ok(await get(handler)), {
    connected: false,
    repositories: [],
    connections: [],
    page: 1,
    per_page: 30,
    total: 0,
    has_more: false,
    truncated: false,
  });
});

Deno.test("another user's connection_id returns 404 without calling GitHub", async () => {
  const { handler, githubCalls, filters } = setup({ rows: [connA] });
  await expectError(await get(handler, `?connection_id=${OTHER_USERS_CONN}`), 404, "connection_not_found");
  assertEquals(githubCalls, []);
  assertEquals(filters[0], [["id", OTHER_USERS_CONN]]);
});

Deno.test("connection_id restricts listing to that connection", async () => {
  const { handler, githubCalls } = setup({
    rows: [connA, connB],
    installations: { 2: { list: listed([repo(20, "acme/api")]) } },
  });
  const body = await ok(await get(handler, `?connection_id=${CONN_B}`));
  assertEquals(githubCalls, ["list:2"]);
  assertEquals(body.repositories.map((r) => r.full_name), ["acme/api"]);
  assertEquals(body.connections.map((c) => c.id), [CONN_B]);
});

// Merge / sort / paginate ---------------------------------------------------------

const reposA = [repo(3, "alice/zeta"), repo(1, "alice/Alpha"), repo(50, "acme/shared")];
const reposB = [repo(50, "acme/shared"), repo(2, "acme/beta"), repo(4, "ACME/beta")];

Deno.test("multiple installations are merged, deduped, and sorted deterministically", async () => {
  const results: RepositoryListResponse[] = [];
  for (const [delayA, delayB] of [[0, 5], [5, 0]]) {
    const { handler } = setup({
      rows: [connA, connB],
      installations: { 1: { list: listed(reposA, false, delayA) }, 2: { list: listed(reposB, false, delayB) } },
    });
    results.push(await ok(await get(handler)));
  }
  assertEquals(results[0], results[1]);
  const body = results[0];
  assertEquals(body.repositories.map((r) => [r.full_name, r.id]), [
    ["acme/beta", 2],
    ["ACME/beta", 4],
    ["acme/shared", 50],
    ["alice/Alpha", 1],
    ["alice/zeta", 3],
  ]);
  assertEquals(body.repositories.find((r) => r.id === 50)?.connection_id, CONN_A);
  assertEquals(body.repositories[0], {
    id: 2,
    connection_id: CONN_B,
    owner: "acme",
    name: "beta",
    full_name: "acme/beta",
    is_private: true,
    default_branch: "main",
    html_url: "https://github.com/acme/beta",
  });
  assertEquals(body.total, 5);
  assertEquals(body.connected, true);
  assertEquals(body.connections, [
    { id: CONN_A, account_login: "alice", status: "ok" },
    { id: CONN_B, account_login: "acme", status: "ok" },
  ]);
});

Deno.test("pagination slices the merged list", async () => {
  const { handler } = setup({
    rows: [connA, connB],
    installations: { 1: { list: listed(reposA) }, 2: { list: listed(reposB) } },
  });
  const first = await ok(await get(handler, "?page=1&per_page=2"));
  assertEquals(first.repositories.map((r) => r.id), [2, 4]);
  assertEquals([first.total, first.has_more], [5, true]);
  const last = await ok(await get(handler, "?page=3&per_page=2"));
  assertEquals(last.repositories.map((r) => r.id), [3]);
  assertEquals(last.has_more, false);
  const past = await ok(await get(handler, "?page=4&per_page=2"));
  assertEquals([past.repositories, past.total, past.has_more], [[], 5, false]);
});

Deno.test("truncation propagates", async () => {
  const { handler } = setup({ rows: [connA], installations: { 1: { list: listed([repo(1, "a/b")], true) } } });
  assertEquals((await ok(await get(handler))).truncated, true);
});

Deno.test("unknown fields from GitHub never reach the response", async () => {
  const { handler } = setup({
    rows: [connA],
    installations: { 1: { list: listed([repo(1, "a/b", { token: "ghs_leak", node_id: "x" })]) } },
  });
  const body = await ok(await get(handler));
  assertEquals(Object.keys(body.repositories[0]).sort(), [
    "connection_id",
    "default_branch",
    "full_name",
    "html_url",
    "id",
    "is_private",
    "name",
    "owner",
  ]);
});

// Partial and total failures ------------------------------------------------------

Deno.test("one failing installation does not fail the request", async () => {
  quietConsole();
  try {
    const { handler, writes } = setup({
      rows: [connA, connB],
      installations: {
        1: { list: () => Promise.reject(new GithubUnavailableError({ status: 503 })) },
        2: { list: listed([repo(2, "acme/api")]) },
      },
    });
    const body = await ok(await get(handler));
    assertEquals(body.repositories.map((r) => r.id), [2]);
    assertEquals(body.connections[0], {
      id: CONN_A,
      account_login: "alice",
      status: "error",
      code: "github_unavailable",
    });
    assertEquals(writes, []);
  } finally {
    restoreConsole();
  }
});

Deno.test("all installations failing with a rate limit returns 503 with the max Retry-After", async () => {
  quietConsole();
  try {
    const { handler } = setup({
      rows: [connA, connB],
      installations: {
        1: { list: () => Promise.reject(new GithubRateLimitedError(30)) },
        2: { list: () => Promise.reject(new GithubRateLimitedError(90)) },
      },
    });
    const res = await get(handler);
    assertEquals(res.headers.get("retry-after"), "90");
    await expectError(res, 503, "github_rate_limited");
  } finally {
    restoreConsole();
  }
});

Deno.test("all installations failing with 5xx returns 502", async () => {
  quietConsole();
  try {
    const { handler } = setup({
      rows: [connA, connB],
      installations: {
        1: { list: () => Promise.reject(new GithubUnavailableError()) },
        2: { list: () => Promise.reject(new GithubUnexpectedResponseError()) },
      },
    });
    await expectError(await get(handler), 502, "github_unavailable");
  } finally {
    restoreConsole();
  }
});

// Lifecycle -----------------------------------------------------------------------

Deno.test("suspended installation is marked suspended", async () => {
  const { handler, writes, githubCalls } = setup({
    rows: [connA],
    installations: {
      1: {
        list: () => Promise.reject(new GithubForbiddenError({ status: 403 })),
        get: () => Promise.resolve(installation(1, "2026-10-03T00:00:00Z")),
      },
    },
  });
  const body = await ok(await get(handler));
  assertEquals(body.connections, [{ id: CONN_A, account_login: "alice", status: "suspended" }]);
  assertEquals(writes, [`markSuspended:${CONN_A}`]);
  assertEquals(githubCalls, ["list:1", "get:1"]);
});

Deno.test("a row already marked suspended stays suspended without listing", async () => {
  const { handler, writes, githubCalls } = setup({
    rows: [{ ...connA, suspended_at: "2026-10-03T00:00:00Z" }],
    installations: { 1: { get: () => Promise.resolve(installation(1, "2026-10-03T00:00:00Z")) } },
  });
  const body = await ok(await get(handler));
  assertEquals(body.connections[0].status, "suspended");
  assertEquals(githubCalls, ["get:1"]);
  assertEquals(writes, []);
});

Deno.test("unsuspended installation is cleared and listed", async () => {
  const { handler, writes } = setup({
    rows: [{ ...connA, suspended_at: "2026-10-03T00:00:00Z" }],
    installations: { 1: { list: listed([repo(1, "alice/app")]) } },
  });
  const body = await ok(await get(handler));
  assertEquals(writes, [`clearSuspended:${CONN_A}`]);
  assertEquals(body.repositories.map((r) => r.id), [1]);
  assertEquals(body.connections[0].status, "ok");
});

Deno.test("uninstalled installation is deleted and reported as removed", async () => {
  const { handler, writes } = setup({
    rows: [connA],
    installations: { 1: { list: () => Promise.reject(new GithubNotFoundError({ status: 404 })) } },
  });
  const body = await ok(await get(handler));
  assertEquals(body.connections, [{ id: CONN_A, account_login: "alice", status: "removed" }]);
  assertEquals(body.connected, false);
  assertEquals(writes, [`deleteConnection:${CONN_A}`]);
});

Deno.test("suspended row whose installation is gone is deleted", async () => {
  const { handler, writes } = setup({
    rows: [{ ...connA, suspended_at: "2026-10-03T00:00:00Z" }],
    installations: { 1: { get: () => Promise.reject(new GithubNotFoundError({ status: 404 })) } },
  });
  assertEquals((await ok(await get(handler))).connections[0].status, "removed");
  assertEquals(writes, [`deleteConnection:${CONN_A}`]);
});

Deno.test("403 on mint for a non-suspended installation is an error without writes", async () => {
  quietConsole();
  try {
    const { handler, writes } = setup({
      rows: [connA, connB],
      installations: {
        1: { list: () => Promise.reject(new GithubForbiddenError({ status: 403 })) },
        2: { list: listed([repo(2, "acme/api")]) },
      },
    });
    const body = await ok(await get(handler));
    assertEquals(body.connections[0], {
      id: CONN_A,
      account_login: "alice",
      status: "error",
      code: "github_unexpected_response",
    });
    assertEquals(writes, []);
  } finally {
    restoreConsole();
  }
});

Deno.test("403/404 from the repository listing are errors without writes", async () => {
  quietConsole();
  try {
    for (const status of [403, 404]) {
      const { handler, writes } = setup({
        rows: [connA, connB],
        installations: {
          1: { list: () => Promise.reject(new GithubUnexpectedResponseError({ status })) },
          2: { list: listed([repo(2, "acme/api")]) },
        },
      });
      const body = await ok(await get(handler));
      assertEquals(body.connections[0].status, "error");
      assertEquals(writes, []);
    }
  } finally {
    restoreConsole();
  }
});

Deno.test("a failing lifecycle write is logged and does not fail the request", async () => {
  const lines = quietConsole();
  try {
    const { handler, writes } = setup({
      rows: [connA],
      failWrites: true,
      installations: { 1: { list: () => Promise.reject(new GithubNotFoundError({ status: 404 })) } },
    });
    const body = await ok(await get(handler));
    assertEquals(body.connections[0].status, "removed");
    assertEquals(writes, [`deleteConnection:${CONN_A}`]);
    const entry = JSON.parse(lines.find((l) => l.includes("github_connection_state_write_failed"))!);
    assertEquals(entry.connection_id, CONN_A);
    assert(!lines.join("\n").includes("db down"));
  } finally {
    restoreConsole();
  }
});

// Service-role writers ------------------------------------------------------------

Deno.test("state writers always filter by connection id and user id", async () => {
  const ops: unknown[][] = [];
  const builder = (op: unknown[]) => {
    const chain = {
      eq(column: string, value: unknown) {
        op.push([column, value]);
        return chain;
      },
      then(resolve: (v: unknown) => unknown) {
        return Promise.resolve({ error: null }).then(resolve);
      },
    };
    return chain;
  };
  const client = {
    from(table: string) {
      assertEquals(table, "github_connections");
      return {
        update(values: unknown) {
          const op: unknown[] = ["update", values];
          ops.push(op);
          return builder(op);
        },
        delete() {
          const op: unknown[] = ["delete"];
          ops.push(op);
          return builder(op);
        },
      };
    },
  } as unknown as SupabaseClient;
  const writers = createConnectionStateWriters(client);
  await writers.markSuspended(CONN_A, userId, "2026-10-03T00:00:00Z");
  await writers.clearSuspended(CONN_A, userId);
  await writers.deleteConnection(CONN_A, userId);
  const scope = [["id", CONN_A], ["user_id", userId]];
  assertEquals(ops, [
    ["update", { suspended_at: "2026-10-03T00:00:00Z" }, ...scope],
    ["update", { suspended_at: null }, ...scope],
    ["delete", ...scope],
  ]);
});
