import { assert, assertEquals } from "@std/assert";
import {
  apiErrorSchema,
  createWorkspaceResponseSchema,
  workspaceDetailResponseSchema,
  workspaceListResponseSchema,
} from "@stackprep/shared";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import type { Authenticate } from "../_shared/auth.ts";
import {
  type GithubApp,
  GithubRateLimitedError,
  type GithubRepo,
  GithubUnavailableError,
  GithubUnexpectedResponseError,
  type InstallationRepositories,
  type RepositoryHead,
} from "../_shared/github-app.ts";
import type { JobEvents, JobQueue } from "../_shared/jobs.ts";
import { assertNoSecrets } from "../_shared/testing.ts";
import {
  type ConnectionRow,
  createWorkspacesHandler,
  type WorkspaceReader,
  type WorkspaceRow,
  type WorkspaceWriters,
} from "./handler.ts";

const userId = "aaaaaaaa-0000-4000-8000-000000000001";
const webOrigin = "http://localhost:3000";
const CONN = "11111111-0000-4000-8000-000000000001";
const OTHER_USERS_CONN = "33333333-0000-4000-8000-000000000003";
const SHA = "0123456789abcdef0123456789abcdef01234567";

const conn: ConnectionRow = { id: CONN, installation_id: 7, suspended_at: null };

function githubRepo(id: number, fullName: string): GithubRepo {
  const [owner, name] = fullName.split("/");
  return {
    id,
    name,
    full_name: fullName,
    private: true,
    default_branch: "main",
    html_url: `https://github.com/${fullName}`,
    owner: { login: owner },
  };
}

function workspaceRow(n: number, githubRepoId: number, extra: Partial<WorkspaceRow> = {}): WorkspaceRow {
  return {
    id: `cccccccc-0000-4000-8000-00000000000${n}`,
    status: "analyzing",
    target_commit_sha: SHA,
    indexed_commit_sha: null,
    created_at: `2026-10-0${n}T00:00:00.000000+00:00`,
    ready_at: null,
    repository: {
      id: `bbbbbbbb-0000-4000-8000-00000000000${n}`,
      github_repo_id: githubRepoId,
      owner: "alice",
      name: `repo-${n}`,
      full_name: `alice/repo-${n}`,
      is_private: false,
      default_branch: "main",
      github_connection_id: CONN,
    },
    ...extra,
  };
}

interface Setup {
  connections?: ConnectionRow[];
  workspaces?: WorkspaceRow[];
  list?: () => Promise<InstallationRepositories>;
  head?: () => Promise<RepositoryHead>;
  failJobInsert?: boolean;
  eventId?: string | null;
  /** Simulates a concurrent request creating the workspace between the existence check and the insert. */
  raceWith?: WorkspaceRow;
  readerError?: boolean;
}

function setup({
  connections = [conn],
  workspaces = [],
  list = () => Promise.resolve({ repositories: [githubRepo(42, "alice/app")], truncated: false }),
  head = () => Promise.resolve({ defaultBranch: "main", commitSha: SHA }),
  failJobInsert = false,
  eventId = null,
  raceWith,
  readerError = false,
}: Setup = {}) {
  const state = { workspaces: [...workspaces] };
  const writes: unknown[][] = [];
  const githubCalls: string[] = [];
  const enqueued: [string, JobEvents["repository.index"]][] = [];
  const rlsClient = { rls: true } as unknown as SupabaseClient;

  const authenticate: Authenticate = (req) =>
    Promise.resolve(
      req.headers.get("Authorization") === "Bearer valid" ? { user: { id: userId } as User, supabase: rlsClient } : null,
    );

  const reader = (client: SupabaseClient): WorkspaceReader => {
    assert(client === rlsClient, "reads must use the caller's RLS client");
    const guard = <T>(value: T) => (readerError ? Promise.reject(new Error("db down")) : Promise.resolve(value));
    return {
      getConnection: (id) => guard(connections.find((c) => c.id === id) ?? null),
      listWorkspaces: () => guard([...state.workspaces]),
      getWorkspace: (id) => guard(state.workspaces.find((w) => w.id === id) ?? null),
      findWorkspaceByGithubRepo: (githubRepoId) =>
        guard(state.workspaces.find((w) => w.repository.github_repo_id === githubRepoId) ?? null),
    };
  };

  let pendingRepo: { id: string; input: Parameters<WorkspaceWriters["upsertRepository"]>[1] } | undefined;
  const writers: WorkspaceWriters = {
    upsertRepository(uid, repo) {
      assertEquals(uid, userId);
      writes.push(["upsertRepository", repo]);
      pendingRepo = { id: "dddddddd-0000-4000-8000-000000000001", input: repo };
      return Promise.resolve(pendingRepo.id);
    },
    insertWorkspace(uid, repositoryId, sha) {
      assertEquals(uid, userId);
      writes.push(["insertWorkspace", repositoryId, sha]);
      if (raceWith) {
        state.workspaces.push(raceWith);
        return Promise.resolve(null);
      }
      const { github_connection_id, github_repo_id, owner, name, full_name, is_private, default_branch } = pendingRepo!
        .input;
      const row: WorkspaceRow = {
        id: "eeeeeeee-0000-4000-8000-000000000001",
        status: "analyzing",
        target_commit_sha: sha,
        indexed_commit_sha: null,
        created_at: "2026-10-04T12:00:00.123456+00:00",
        ready_at: null,
        repository: {
          id: repositoryId,
          github_repo_id,
          owner,
          name,
          full_name,
          is_private,
          default_branch,
          github_connection_id,
        },
      };
      state.workspaces.push(row);
      return Promise.resolve(row.id);
    },
    attachConnection(uid, repositoryId, connectionId) {
      assertEquals(uid, userId);
      writes.push(["attachConnection", repositoryId, connectionId]);
      return Promise.resolve();
    },
    insertIndexingJob(uid, workspaceId) {
      assertEquals(uid, userId);
      writes.push(["insertIndexingJob", workspaceId]);
      return failJobInsert ? Promise.reject(new Error("db down")) : Promise.resolve("job-1");
    },
    setJobEventId(uid, jobId, id) {
      assertEquals(uid, userId);
      writes.push(["setJobEventId", jobId, id]);
      return Promise.resolve();
    },
  };

  const github: Pick<GithubApp, "listAllInstallationRepositories" | "getRepositoryHead"> = {
    listAllInstallationRepositories(id) {
      githubCalls.push(`list:${id}`);
      return list();
    },
    getRepositoryHead(id, owner, name) {
      githubCalls.push(`head:${id}:${owner}/${name}`);
      return head();
    },
  };

  const jobs: JobQueue = {
    enqueue(name, payload) {
      enqueued.push([name, payload]);
      return Promise.resolve({ eventId });
    },
  };

  const handler = createWorkspacesHandler({ webOrigin, authenticate, github, reader, writers, jobs });
  return { handler, writes, githubCalls, enqueued, state };
}

type Handler = (req: Request) => Promise<Response>;

function request(handler: Handler, path: string, init: RequestInit = {}, auth = "Bearer valid") {
  return handler(
    new Request(`http://localhost${path}`, {
      ...init,
      headers: { Authorization: auth, Origin: webOrigin, ...init.headers },
    }),
  );
}

function post(handler: Handler, body: unknown, auth = "Bearer valid") {
  return request(
    handler,
    "/workspaces",
    { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) },
    auth,
  );
}

const validBody = { connection_id: CONN, github_repo_id: 42 };

async function expectError(res: Response, status: number, code: string) {
  assertEquals(res.status, status);
  assertEquals(res.headers.get("access-control-allow-origin"), webOrigin);
  await assertNoSecrets(res);
  assertEquals(apiErrorSchema.parse(await res.json()).code, code);
}

let restoreConsole: () => void = () => {};
function quietConsole(): string[] {
  const lines: string[] = [];
  const original = console.error;
  console.error = (line: string) => lines.push(line);
  restoreConsole = () => (console.error = original);
  return lines;
}

// Routing / CORS / auth -------------------------------------------------------------

Deno.test("CORS, preflight, routing, method, and auth checks", async () => {
  const { handler, githubCalls } = setup();
  const foreign = await handler(
    new Request("http://localhost/workspaces", { headers: { Origin: "https://evil.example" } }),
  );
  assertEquals(foreign.status, 403);

  const preflight = await handler(
    new Request("http://localhost/workspaces", { method: "OPTIONS", headers: { Origin: webOrigin } }),
  );
  assertEquals(preflight.status, 204);
  assertEquals(preflight.headers.get("access-control-allow-methods"), "GET, POST, OPTIONS");

  await expectError(await request(handler, "/elsewhere"), 404, "not_found");
  await expectError(await request(handler, "/workspaces/a/b"), 404, "not_found");

  const del = await request(handler, "/workspaces", { method: "DELETE" });
  assertEquals(del.headers.get("allow"), "GET, POST, OPTIONS");
  await expectError(del, 405, "method_not_allowed");
  const postToId = await request(handler, `/workspaces/${crypto.randomUUID()}`, { method: "POST" });
  assertEquals(postToId.headers.get("allow"), "GET, OPTIONS");
  await expectError(postToId, 405, "method_not_allowed");

  await expectError(await post(handler, validBody, ""), 401, "unauthorized");
  await expectError(await request(handler, "/workspaces", {}, "Bearer forged"), 401, "unauthorized");
  await expectError(await request(handler, `/workspaces/${crypto.randomUUID()}`, {}, ""), 401, "unauthorized");
  assertEquals(githubCalls, []);
});

Deno.test("routes under the /functions/v1 prefix", async () => {
  const { handler } = setup({ workspaces: [workspaceRow(1, 1)] });
  const res = await request(handler, "/functions/v1/workspaces");
  assertEquals(res.status, 200);
});

// POST /workspaces -----------------------------------------------------------------

Deno.test("invalid bodies return 400 without calling GitHub", async () => {
  const { handler, githubCalls, writes } = setup();
  for (
    const body of [
      "not json",
      {},
      { connection_id: CONN },
      { connection_id: "nope", github_repo_id: 42 },
      { connection_id: CONN, github_repo_id: 0 },
      { connection_id: CONN, github_repo_id: "42" },
      { ...validBody, owner: "evil", name: "repo" },
    ]
  ) {
    await expectError(await post(handler, body), 400, "invalid_request");
  }
  assertEquals(githubCalls, []);
  assertEquals(writes, []);
});

Deno.test("another user's connection returns 404 without calling GitHub", async () => {
  const { handler, githubCalls, writes } = setup();
  await expectError(await post(handler, { ...validBody, connection_id: OTHER_USERS_CONN }), 404, "connection_not_found");
  assertEquals(githubCalls, []);
  assertEquals(writes, []);
});

Deno.test("a suspended connection is rejected", async () => {
  const { handler, githubCalls } = setup({ connections: [{ ...conn, suspended_at: "2026-10-03T00:00:00Z" }] });
  await expectError(await post(handler, validBody), 409, "installation_suspended");
  assertEquals(githubCalls, []);
});

Deno.test("a repository the installation cannot see is rejected without writes", async () => {
  const { handler, githubCalls, writes, enqueued } = setup({
    list: () => Promise.resolve({ repositories: [githubRepo(99, "alice/other")], truncated: false }),
  });
  await expectError(await post(handler, validBody), 403, "repository_not_accessible");
  assertEquals(githubCalls, ["list:7"]);
  assertEquals(writes, []);
  assertEquals(enqueued, []);
});

Deno.test("creates a workspace pinned to the head commit and enqueues indexing", async () => {
  const { handler, githubCalls, writes, enqueued } = setup({
    list: () =>
      Promise.resolve({ repositories: [githubRepo(1, "alice/x"), githubRepo(42, "Acme/App")], truncated: false }),
  });
  const res = await post(handler, validBody);
  assertEquals(res.status, 201);
  assertEquals(res.headers.get("cache-control"), "no-store");
  await assertNoSecrets(res);
  const body = createWorkspaceResponseSchema.parse(await res.json());

  assertEquals(githubCalls, ["list:7", "head:7:Acme/App"]);
  const repositoryId = "dddddddd-0000-4000-8000-000000000001";
  const workspaceId = "eeeeeeee-0000-4000-8000-000000000001";
  assertEquals(writes, [
    ["upsertRepository", {
      github_connection_id: CONN,
      github_repo_id: 42,
      owner: "Acme",
      name: "App",
      full_name: "Acme/App",
      is_private: true,
      default_branch: "main",
    }],
    ["insertWorkspace", repositoryId, SHA],
    ["insertIndexingJob", workspaceId],
  ]);
  assertEquals(enqueued, [[
    "repository.index",
    { workspace_id: workspaceId, repository_id: repositoryId, commit_sha: SHA, installation_id: 7 },
  ]]);
  assertEquals(body, {
    created: true,
    workspace: {
      id: workspaceId,
      status: "analyzing",
      repository: {
        id: repositoryId,
        github_repo_id: 42,
        owner: "Acme",
        name: "App",
        full_name: "Acme/App",
        is_private: true,
        default_branch: "main",
        html_url: "https://github.com/Acme/App",
      },
      target_commit_sha: SHA,
      indexed_commit_sha: null,
      created_at: "2026-10-04T12:00:00.123456+00:00",
      ready_at: null,
    },
  });
});

Deno.test("records the runner's event id when one is returned", async () => {
  const { handler, writes } = setup({ eventId: "evt_123" });
  assertEquals((await post(handler, validBody)).status, 201);
  assertEquals(writes.at(-1), ["setJobEventId", "job-1", "evt_123"]);
});

Deno.test("an existing workspace is returned without a commit lookup or a new job", async () => {
  const existing = workspaceRow(1, 42);
  const { handler, githubCalls, writes, enqueued } = setup({ workspaces: [existing] });
  const res = await post(handler, validBody);
  assertEquals(res.status, 200);
  const body = createWorkspaceResponseSchema.parse(await res.json());
  assertEquals([body.created, body.workspace.id], [false, existing.id]);
  assertEquals(githubCalls, ["list:7"]);
  assertEquals(writes, []);
  assertEquals(enqueued, []);
});

Deno.test("an existing workspace whose connection was removed is re-attached", async () => {
  const existing = workspaceRow(1, 42);
  existing.repository.github_connection_id = null;
  const { handler, writes } = setup({ workspaces: [existing] });
  assertEquals((await post(handler, validBody)).status, 200);
  assertEquals(writes, [["attachConnection", existing.repository.id, CONN]]);
});

Deno.test("a concurrent create falls back to the existing workspace", async () => {
  const raced = workspaceRow(2, 42);
  const { handler, writes, enqueued } = setup({ raceWith: raced });
  const res = await post(handler, validBody);
  assertEquals(res.status, 200);
  const body = createWorkspaceResponseSchema.parse(await res.json());
  assertEquals([body.created, body.workspace.id], [false, raced.id]);
  assertEquals(writes.map((w) => w[0]), ["upsertRepository", "insertWorkspace"]);
  assertEquals(enqueued, []);
});

Deno.test("a failed job insert is logged and the workspace is still created", async () => {
  const lines = quietConsole();
  try {
    const { handler, enqueued } = setup({ failJobInsert: true });
    const res = await post(handler, validBody);
    assertEquals(res.status, 201);
    assertEquals(createWorkspaceResponseSchema.parse(await res.json()).workspace.status, "analyzing");
    assertEquals(enqueued, []);
    const entry = JSON.parse(lines.find((l) => l.includes("workspace_indexing_enqueue_failed"))!);
    assertEquals(entry.workspace_id, "eeeeeeee-0000-4000-8000-000000000001");
    assert(!lines.join("\n").includes("db down"));
  } finally {
    restoreConsole();
  }
});

Deno.test("GitHub errors are mapped to API errors", async () => {
  quietConsole();
  try {
    const limited = setup({ list: () => Promise.reject(new GithubRateLimitedError(42)) });
    const res = await post(limited.handler, validBody);
    assertEquals(res.headers.get("retry-after"), "42");
    await expectError(res, 503, "github_rate_limited");

    const down = setup({ list: () => Promise.reject(new GithubUnavailableError({ status: 502 })) });
    await expectError(await post(down.handler, validBody), 502, "github_unavailable");

    const headFails = setup({ head: () => Promise.reject(new GithubUnexpectedResponseError({ status: 404 })) });
    await expectError(await post(headFails.handler, validBody), 502, "github_unexpected_response");
    assertEquals(headFails.writes, []);
    assertEquals(headFails.enqueued, []);
  } finally {
    restoreConsole();
  }
});

Deno.test("a database error returns 500", async () => {
  quietConsole();
  try {
    const { handler } = setup({ readerError: true });
    await expectError(await post(handler, validBody), 500, "internal_error");
    await expectError(await request(handler, "/workspaces"), 500, "internal_error");
  } finally {
    restoreConsole();
  }
});

// GET /workspaces ------------------------------------------------------------------

Deno.test("lists the caller's workspaces", async () => {
  const { handler } = setup({ workspaces: [workspaceRow(2, 2), workspaceRow(1, 1)] });
  const res = await request(handler, "/workspaces");
  assertEquals(res.status, 200);
  await assertNoSecrets(res);
  const body = workspaceListResponseSchema.parse(await res.json());
  assertEquals(body.workspaces.map((w) => w.repository.full_name), ["alice/repo-2", "alice/repo-1"]);
  assert(!("github_connection_id" in body.workspaces[0].repository));
});

Deno.test("an empty list is returned when there are no workspaces", async () => {
  const { handler } = setup();
  assertEquals(workspaceListResponseSchema.parse(await (await request(handler, "/workspaces")).json()), {
    workspaces: [],
  });
});

// GET /workspaces/:id --------------------------------------------------------------

Deno.test("returns workspace detail with an empty interview history", async () => {
  const row = workspaceRow(1, 1, {
    status: "ready",
    indexed_commit_sha: SHA,
    ready_at: "2026-10-01T01:00:00+00:00",
  });
  const { handler } = setup({ workspaces: [row] });
  const res = await request(handler, `/workspaces/${row.id}`);
  assertEquals(res.status, 200);
  const body = workspaceDetailResponseSchema.parse(await res.json());
  assertEquals(body.interviews, []);
  assertEquals(body.repository, body.workspace.repository);
  assertEquals(body.repository.html_url, "https://github.com/alice/repo-1");
  assertEquals(body.workspace.status, "ready");
});

Deno.test("unknown, other users', and malformed workspace ids return 404", async () => {
  const { handler } = setup({ workspaces: [workspaceRow(1, 1)] });
  await expectError(await request(handler, `/workspaces/${crypto.randomUUID()}`), 404, "workspace_not_found");
  await expectError(await request(handler, "/workspaces/not-a-uuid"), 404, "workspace_not_found");
});
