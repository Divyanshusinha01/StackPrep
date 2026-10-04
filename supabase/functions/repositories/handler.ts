import {
  type ConnectionErrorCode,
  type ConnectionStatus,
  type Repository,
  repositoryListQuerySchema,
  repositoryListResponseSchema,
} from "@stackprep/shared";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Authenticate } from "../_shared/auth.ts";
import {
  type GithubApp,
  GithubError,
  GithubForbiddenError,
  GithubNotFoundError,
  GithubRateLimitedError,
  type GithubRepo,
} from "../_shared/github-app.ts";
import { apiError, githubErrorCode, logGithubError } from "../_shared/github-errors.ts";
import { createCors, json } from "../_shared/http.ts";

const FN = "repositories";

export interface ConnectionRow {
  id: string;
  installation_id: number;
  account_login: string;
  suspended_at: string | null;
  created_at: string;
}

/** Service-role writes. Only called with connection ids just read through the caller's RLS client. */
export interface ConnectionStateWriters {
  markSuspended(connectionId: string, userId: string, suspendedAt: string): Promise<void>;
  clearSuspended(connectionId: string, userId: string): Promise<void>;
  deleteConnection(connectionId: string, userId: string): Promise<void>;
}

export interface RepositoriesHandlerOptions extends ConnectionStateWriters {
  webOrigin: string;
  authenticate: Authenticate;
  github: Pick<GithubApp, "getInstallation" | "listAllInstallationRepositories">;
}

type Outcome =
  | { status: "ok"; repositories: GithubRepo[]; truncated: boolean }
  | { status: "suspended" | "removed" }
  | { status: "error"; code: ConnectionErrorCode; retryAfter?: number };

export function createConnectionStateWriters(serviceClient: SupabaseClient): ConnectionStateWriters {
  const table = () => serviceClient.from("github_connections");
  async function run(action: string, op: PromiseLike<{ error: { message: string } | null }>): Promise<void> {
    const { error } = await op;
    if (error) {
      throw new Error(`Failed to ${action} GitHub connection: ${error.message}`);
    }
  }
  return {
    markSuspended: (connectionId, userId, suspendedAt) =>
      run("suspend", table().update({ suspended_at: suspendedAt }).eq("id", connectionId).eq("user_id", userId)),
    clearSuspended: (connectionId, userId) =>
      run("unsuspend", table().update({ suspended_at: null }).eq("id", connectionId).eq("user_id", userId)),
    deleteConnection: (connectionId, userId) =>
      run("delete", table().delete().eq("id", connectionId).eq("user_id", userId)),
  };
}

function compareRepositories(a: Repository, b: Repository): number {
  const an = a.full_name.toLowerCase();
  const bn = b.full_name.toLowerCase();
  if (an < bn) return -1;
  if (an > bn) return 1;
  return a.id - b.id;
}

export function createRepositoriesHandler({
  webOrigin,
  authenticate,
  github,
  markSuspended,
  clearSuspended,
  deleteConnection,
}: RepositoriesHandlerOptions) {
  const cors = createCors(webOrigin, ["GET"]);

  async function writeState(conn: ConnectionRow, write: () => Promise<void>): Promise<void> {
    try {
      await write();
    } catch (err) {
      logGithubError(FN, err, {
        event: "github_connection_state_write_failed",
        code: "internal_error",
        installation_id: conn.installation_id,
        connection_id: conn.id,
      });
    }
  }

  function errorOutcome(conn: ConnectionRow, err: unknown, code?: ConnectionErrorCode): Outcome {
    const resolved = code ?? (err instanceof GithubError ? githubErrorCode(err) : "github_unexpected_response");
    logGithubError(FN, err, { code: resolved, installation_id: conn.installation_id, connection_id: conn.id });
    return {
      status: "error",
      code: resolved,
      retryAfter: err instanceof GithubRateLimitedError ? err.retryAfterSeconds : undefined,
    };
  }

  /** Re-reads the installation with the App JWT to decide between suspended, removed, and active. */
  async function checkInstallation(
    conn: ConnectionRow,
    userId: string,
  ): Promise<{ outcome: Outcome } | { active: true }> {
    try {
      const { suspended_at: suspendedAt } = await github.getInstallation(conn.installation_id);
      if (suspendedAt !== null) {
        if (conn.suspended_at === null) {
          await writeState(conn, () => markSuspended(conn.id, userId, suspendedAt));
        }
        return { outcome: { status: "suspended" } };
      }
      return { active: true };
    } catch (err) {
      if (err instanceof GithubNotFoundError) {
        await writeState(conn, () => deleteConnection(conn.id, userId));
        return { outcome: { status: "removed" } };
      }
      return { outcome: errorOutcome(conn, err) };
    }
  }

  async function loadConnection(conn: ConnectionRow, userId: string): Promise<Outcome> {
    if (conn.suspended_at !== null) {
      const checked = await checkInstallation(conn, userId);
      if ("outcome" in checked) {
        return checked.outcome;
      }
      await writeState(conn, () => clearSuspended(conn.id, userId));
    }

    try {
      const { repositories, truncated } = await github.listAllInstallationRepositories(conn.installation_id);
      return { status: "ok", repositories, truncated };
    } catch (err) {
      if (err instanceof GithubNotFoundError) {
        await writeState(conn, () => deleteConnection(conn.id, userId));
        return { status: "removed" };
      }
      if (err instanceof GithubForbiddenError) {
        const checked = await checkInstallation(conn, userId);
        if ("outcome" in checked) {
          return checked.outcome;
        }
        return errorOutcome(conn, err, "github_unexpected_response");
      }
      return errorOutcome(conn, err);
    }
  }

  async function listRepositories(req: Request): Promise<Response> {
    const ctx = await authenticate(req);
    if (!ctx) {
      return apiError("unauthorized", cors);
    }

    const params = new URL(req.url).searchParams;
    const keys = [...params.keys()];
    if (new Set(keys).size !== keys.length) {
      return apiError("invalid_request", cors);
    }
    const parsed = repositoryListQuerySchema.safeParse(Object.fromEntries(params));
    if (!parsed.success) {
      return apiError("invalid_request", cors);
    }
    const { page, per_page: perPage, connection_id: connectionId } = parsed.data;

    let query = ctx.supabase
      .from("github_connections")
      .select("id, installation_id, account_login, suspended_at, created_at");
    if (connectionId) {
      query = query.eq("id", connectionId);
    }
    const { data, error } = await query.order("created_at").order("id");
    if (error) {
      throw new Error(`Failed to load GitHub connections: ${error.message}`);
    }
    const rows = (data ?? []) as ConnectionRow[];

    if (rows.length === 0 && connectionId) {
      return apiError("connection_not_found", cors);
    }

    const settled = await Promise.allSettled(rows.map((row) => loadConnection(row, ctx.user.id)));
    const outcomes = settled.map((result, i): Outcome =>
      result.status === "fulfilled" ? result.value : errorOutcome(rows[i], result.reason)
    );

    const connections: ConnectionStatus[] = rows.map((row, i) => {
      const outcome = outcomes[i];
      return outcome.status === "error"
        ? { id: row.id, account_login: row.account_login, status: "error", code: outcome.code }
        : { id: row.id, account_login: row.account_login, status: outcome.status };
    });

    const anyOk = outcomes.some((o) => o.status === "ok");
    const errors = outcomes.filter((o) => o.status === "error");
    if (!anyOk && errors.length > 0) {
      const retryAfters = errors.flatMap((o) => (o.code === "github_rate_limited" ? [o.retryAfter ?? 60] : []));
      if (retryAfters.length > 0) {
        return apiError("github_rate_limited", cors, { "Retry-After": String(Math.max(...retryAfters)) });
      }
      return apiError("github_unavailable", cors);
    }

    const byId = new Map<number, Repository>();
    let truncated = false;
    outcomes.forEach((outcome, i) => {
      if (outcome.status !== "ok") {
        return;
      }
      truncated ||= outcome.truncated;
      for (const repo of outcome.repositories) {
        const existing = byId.get(repo.id);
        if (existing && existing.connection_id < rows[i].id) {
          continue;
        }
        byId.set(repo.id, {
          id: repo.id,
          connection_id: rows[i].id,
          owner: repo.owner.login,
          name: repo.name,
          full_name: repo.full_name,
          is_private: repo.private,
          default_branch: repo.default_branch,
          html_url: repo.html_url,
        });
      }
    });
    const all = [...byId.values()].sort(compareRepositories);
    const start = (page - 1) * perPage;

    const body = repositoryListResponseSchema.parse({
      connected: connections.some((c) => c.status !== "removed"),
      repositories: all.slice(start, start + perPage),
      connections,
      page,
      per_page: perPage,
      total: all.length,
      has_more: page * perPage < all.length,
      truncated,
    });
    return json(body, { headers: cors.headers });
  }

  return async (req: Request): Promise<Response> => {
    const rejected = cors.rejectOrigin(req);
    if (rejected) {
      return rejected;
    }

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors.headers });
    }

    if (req.method !== "GET") {
      return apiError("method_not_allowed", cors, { Allow: "GET, OPTIONS" });
    }

    try {
      return await listRepositories(req);
    } catch (err) {
      logGithubError(FN, err, { code: "internal_error" });
      return apiError("internal_error", cors);
    }
  };
}
