import { assert, assertEquals } from "@std/assert";
import { apiErrorSchema, connectGithubResponseSchema } from "@stackprep/shared";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import type { Authenticate } from "../_shared/auth.ts";
import {
  type GithubApp,
  type GithubInstallation,
  GithubNotFoundError,
  GithubOAuthCodeError,
  GithubRateLimitedError,
  GithubUnavailableError,
  GithubUnexpectedResponseError,
  type UserInstallationCheck,
} from "../_shared/github-app.ts";
import { assertNoSecrets } from "../_shared/testing.ts";
import {
  type ConnectionUpsert,
  createGithubConnectHandler,
  createUpsertConnection,
  type StoredConnection,
} from "./handler.ts";

const APP_ID = "1234";
const userId = "aaaaaaaa-0000-4000-8000-000000000001";
const url = "http://localhost/github/connect";
const webOrigin = "http://localhost:3000";

const users: Record<string, User> = {
  "Bearer valid": { id: userId, identities: [{ provider: "github", id: "99" }] } as unknown as User,
  "Bearer no-github": { id: userId, identities: [{ provider: "email", id: userId }] } as unknown as User,
};

const authenticate: Authenticate = (req) => {
  const user = users[req.headers.get("Authorization") ?? ""];
  return Promise.resolve(user ? { user, supabase: {} as SupabaseClient } : null);
};

const goodInstallation: GithubInstallation = {
  id: 7,
  app_id: Number(APP_ID),
  account: { id: 99, login: "alice", type: "User" },
  repository_selection: "all",
  permissions: { metadata: "read", contents: "read" },
  suspended_at: null,
};

interface Setup {
  verify?: () => Promise<UserInstallationCheck>;
  installation?: () => Promise<GithubInstallation>;
  upsertError?: boolean;
}

function setup({ verify, installation, upsertError }: Setup = {}) {
  const rows = new Map<string, StoredConnection>();
  const upserts: { userId: string; data: ConnectionUpsert }[] = [];
  const github: Pick<GithubApp, "verifyUserInstallation" | "getInstallation"> = {
    verifyUserInstallation: verify ??
      (() => Promise.resolve({ githubUserId: 99, githubLogin: "alice", hasInstallation: true })),
    getInstallation: installation ?? (() => Promise.resolve(goodInstallation)),
  };
  const handler = createGithubConnectHandler({
    webOrigin,
    authenticate,
    github,
    appId: APP_ID,
    upsertConnection: (uid, data) => {
      upserts.push({ userId: uid, data });
      if (upsertError) {
        return Promise.reject(new Error("db down"));
      }
      const key = `${uid}:${data.installation_id}`;
      const row = {
        id: rows.get(key)?.id ?? crypto.randomUUID(),
        account_login: data.account_login,
        account_type: data.account_type,
        repository_selection: data.repository_selection,
        suspended_at: null,
      };
      rows.set(key, row);
      return Promise.resolve(row);
    },
  });
  return { handler, rows, upserts };
}

function post(body: unknown, auth = "Bearer valid", target = url) {
  return new Request(target, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json", Origin: webOrigin },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const validBody = { code: "abc123", installation_id: 7 };

async function expectError(res: Response, status: number, code: string) {
  assertEquals(res.status, status);
  assertEquals(res.headers.get("access-control-allow-origin"), webOrigin);
  assertEquals(res.headers.get("cache-control"), "no-store");
  await assertNoSecrets(res);
  assertEquals(apiErrorSchema.parse(await res.json()).code, code);
}

const quietConsole = () => {
  const original = console.error;
  console.error = () => {};
  return () => (console.error = original);
};

// CORS / routing / auth ------------------------------------------------------------

Deno.test("rejects other origins before authenticating", async () => {
  const { handler } = setup();
  const res = await handler(
    new Request(url, { method: "POST", headers: { Origin: "https://evil.example", Authorization: "Bearer valid" } }),
  );
  assertEquals(res.status, 403);
});

Deno.test("OPTIONS preflight returns 204", async () => {
  const { handler } = setup();
  const res = await handler(new Request(url, { method: "OPTIONS", headers: { Origin: webOrigin } }));
  assertEquals(res.status, 204);
  assertEquals(res.headers.get("access-control-allow-methods"), "POST, OPTIONS");
});

Deno.test("GET returns 405", async () => {
  const { handler } = setup();
  const res = await handler(new Request(url, { headers: { Authorization: "Bearer valid" } }));
  assertEquals(res.headers.get("allow"), "POST, OPTIONS");
  await expectError(res, 405, "method_not_allowed");
});

Deno.test("unknown path returns 404", async () => {
  const { handler } = setup();
  await expectError(await handler(post(validBody, "Bearer valid", "http://localhost/github/other")), 404, "not_found");
});

Deno.test("serves the gateway path", async () => {
  const { handler } = setup();
  const res = await handler(post(validBody, "Bearer valid", "http://localhost/functions/v1/github/connect"));
  assertEquals(res.status, 200);
});

Deno.test("missing or anonymous tokens return 401", async () => {
  const { handler } = setup();
  await expectError(await handler(post(validBody, "")), 401, "unauthorized");
  await expectError(await handler(post(validBody, "Bearer anon")), 401, "unauthorized");
});

// Validation ----------------------------------------------------------------------

Deno.test("invalid bodies return 400", async () => {
  const { handler, upserts } = setup();
  const bodies: unknown[] = [
    "{not json",
    {},
    { code: "abc" },
    { installation_id: 7 },
    { ...validBody, extra: true },
    { code: "abc", installation_id: 1.5 },
    { code: "abc", installation_id: 0 },
    { code: "abc", installation_id: "7" },
    { code: "abc def", installation_id: 7 },
    { code: "abc;drop", installation_id: 7 },
  ];
  for (const body of bodies) {
    await expectError(await handler(post(body)), 400, "invalid_request");
  }
  assertEquals(upserts.length, 0);
});

// GitHub verification outcomes ----------------------------------------------------

Deno.test("GitHub verification failures map to the expected codes", async () => {
  const restore = quietConsole();
  try {
    const cases: [Setup, number, string][] = [
      [{ verify: () => Promise.reject(new GithubOAuthCodeError()) }, 400, "invalid_oauth_code"],
      [
        { verify: () => Promise.resolve({ githubUserId: 100, githubLogin: "mallory", hasInstallation: true }) },
        403,
        "github_account_mismatch",
      ],
      [
        { verify: () => Promise.resolve({ githubUserId: 99, githubLogin: "alice", hasInstallation: false }) },
        403,
        "installation_not_accessible",
      ],
      [{ installation: () => Promise.reject(new GithubNotFoundError({ status: 404 })) }, 403, "installation_not_accessible"],
      [
        { installation: () => Promise.resolve({ ...goodInstallation, app_id: 999 }) },
        403,
        "installation_not_accessible",
      ],
      [{ installation: () => Promise.resolve({ ...goodInstallation, id: 8 }) }, 403, "installation_not_accessible"],
      [
        { installation: () => Promise.resolve({ ...goodInstallation, account: { id: 1, type: "Enterprise" } }) },
        422,
        "unsupported_installation_account",
      ],
      [
        { installation: () => Promise.resolve({ ...goodInstallation, account: null }) },
        422,
        "unsupported_installation_account",
      ],
      [
        { installation: () => Promise.resolve({ ...goodInstallation, suspended_at: "2026-10-01T00:00:00Z" }) },
        409,
        "installation_suspended",
      ],
      [{ verify: () => Promise.reject(new GithubUnavailableError({ status: 503 })) }, 502, "github_unavailable"],
      [{ verify: () => Promise.reject(new GithubUnavailableError()) }, 502, "github_unavailable"],
      [{ verify: () => Promise.reject(new GithubUnexpectedResponseError()) }, 502, "github_unexpected_response"],
      [
        { installation: () => Promise.reject(new GithubUnexpectedResponseError({ status: 200 })) },
        502,
        "github_unexpected_response",
      ],
      [{ upsertError: true }, 500, "internal_error"],
    ];
    for (const [options, status, code] of cases) {
      const { handler, rows } = setup(options);
      await expectError(await handler(post(validBody)), status, code);
      assertEquals(rows.size, 0);
    }
  } finally {
    restore();
  }
});

Deno.test("users without a GitHub identity get 403 without calling GitHub", async () => {
  let called = false;
  const { handler } = setup({
    verify: () => {
      called = true;
      return Promise.resolve({ githubUserId: 99, githubLogin: "alice", hasInstallation: true });
    },
  });
  await expectError(await handler(post(validBody, "Bearer no-github")), 403, "github_account_mismatch");
  assertEquals(called, false);
});

Deno.test("rate limiting returns 503 with Retry-After", async () => {
  const restore = quietConsole();
  try {
    const { handler } = setup({ verify: () => Promise.reject(new GithubRateLimitedError(120, { status: 429 })) });
    const res = await handler(post(validBody));
    assertEquals(res.headers.get("retry-after"), "120");
    await expectError(res, 503, "github_rate_limited");
  } finally {
    restore();
  }
});

// Success + idempotency -----------------------------------------------------------

Deno.test("connect upserts with the JWT user and returns connection metadata", async () => {
  const { handler, upserts } = setup();
  const res = await handler(post(validBody));
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("cache-control"), "no-store");
  await assertNoSecrets(res);
  const body = connectGithubResponseSchema.parse(await res.json());
  assertEquals(body.connection.account_login, "alice");
  assertEquals(body.connection.account_type, "User");
  assertEquals(body.connection.suspended, false);
  assertEquals(upserts, [{
    userId,
    data: {
      github_user_id: 99,
      installation_id: 7,
      account_login: "alice",
      account_type: "User",
      repository_selection: "all",
      permissions: { metadata: "read", contents: "read" },
    },
  }]);
});

Deno.test("reconnecting the same installation returns the same connection id", async () => {
  const { handler, rows } = setup();
  const first = connectGithubResponseSchema.parse(await (await handler(post(validBody))).json());
  const second = connectGithubResponseSchema.parse(await (await handler(post(validBody))).json());
  assertEquals(first.connection.id, second.connection.id);
  assertEquals(rows.size, 1);
});

Deno.test("createUpsertConnection upserts on (user_id, installation_id) and clears suspension", async () => {
  const captured: { table?: string; values?: unknown; options?: unknown; columns?: string } = {};
  const row = {
    id: crypto.randomUUID(),
    account_login: "alice",
    account_type: "User",
    repository_selection: "all",
    suspended_at: null,
  };
  const client = {
    from(table: string) {
      captured.table = table;
      return {
        upsert(values: unknown, options: unknown) {
          captured.values = values;
          captured.options = options;
          return {
            select(columns: string) {
              captured.columns = columns;
              return { single: () => Promise.resolve({ data: row, error: null }) };
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;
  const data: ConnectionUpsert = {
    github_user_id: 99,
    installation_id: 7,
    account_login: "alice",
    account_type: "User",
    repository_selection: "all",
    permissions: {},
  };
  assertEquals(await createUpsertConnection(client)(userId, data), row);
  assertEquals(captured.table, "github_connections");
  assertEquals(captured.values, { user_id: userId, ...data, suspended_at: null });
  assertEquals(captured.options, { onConflict: "user_id,installation_id" });
  assert(!captured.columns?.includes("user_id"));
});
