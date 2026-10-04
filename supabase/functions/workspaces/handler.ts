import {
  createWorkspaceRequestSchema,
  createWorkspaceResponseSchema,
  repositoryHtmlUrl,
  type Workspace,
  workspaceDetailResponseSchema,
  workspaceIdParamSchema,
  workspaceListResponseSchema,
  type WorkspaceStatus,
} from "@stackprep/shared";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Authenticate } from "../_shared/auth.ts";
import type { GithubApp, GithubRepo } from "../_shared/github-app.ts";
import { apiError, githubErrorResponse, logGithubError } from "../_shared/github-errors.ts";
import { createCors, json } from "../_shared/http.ts";
import type { JobQueue } from "../_shared/jobs.ts";

const FN = "workspaces";
const UNIQUE_VIOLATION = "23505";

const WORKSPACE_COLUMNS = "id, status, target_commit_sha, indexed_commit_sha, created_at, ready_at, " +
  "repository:repositories!workspaces_repository_id_user_id_fkey" +
  "(id, github_repo_id, owner, name, full_name, is_private, default_branch, github_connection_id)";

export interface ConnectionRow {
  id: string;
  installation_id: number;
  suspended_at: string | null;
}

export interface WorkspaceRow {
  id: string;
  status: WorkspaceStatus;
  target_commit_sha: string | null;
  indexed_commit_sha: string | null;
  created_at: string;
  ready_at: string | null;
  repository: {
    id: string;
    github_repo_id: number;
    owner: string;
    name: string;
    full_name: string;
    is_private: boolean;
    default_branch: string;
    github_connection_id: string | null;
  };
}

/** Reads made with the caller's client, so RLS limits every result to their own rows. */
export interface WorkspaceReader {
  getConnection(connectionId: string): Promise<ConnectionRow | null>;
  listWorkspaces(): Promise<WorkspaceRow[]>;
  getWorkspace(workspaceId: string): Promise<WorkspaceRow | null>;
  findWorkspaceByGithubRepo(githubRepoId: number): Promise<WorkspaceRow | null>;
}

export interface RepositoryInput {
  github_connection_id: string;
  github_repo_id: number;
  owner: string;
  name: string;
  full_name: string;
  is_private: boolean;
  default_branch: string;
}

/** Service-role writes. Every call is scoped to the authenticated user's id. */
export interface WorkspaceWriters {
  upsertRepository(userId: string, repo: RepositoryInput): Promise<string>;
  /** Returns the new workspace id, or null when the repository already has a workspace. */
  insertWorkspace(userId: string, repositoryId: string, targetCommitSha: string): Promise<string | null>;
  attachConnection(userId: string, repositoryId: string, connectionId: string): Promise<void>;
  insertIndexingJob(userId: string, workspaceId: string): Promise<string>;
  setJobEventId(userId: string, jobId: string, eventId: string): Promise<void>;
}

export interface WorkspacesHandlerOptions {
  webOrigin: string;
  authenticate: Authenticate;
  github: Pick<GithubApp, "listAllInstallationRepositories" | "getRepositoryHead">;
  reader: (client: SupabaseClient) => WorkspaceReader;
  writers: WorkspaceWriters;
  jobs: JobQueue;
}

export function createWorkspaceReader(client: SupabaseClient): WorkspaceReader {
  async function maybeOne<T>(
    action: string,
    op: PromiseLike<{ data: unknown; error: { message: string } | null }>,
  ): Promise<T | null> {
    const { data, error } = await op;
    if (error) {
      throw new Error(`Failed to ${action}: ${error.message}`);
    }
    return (data ?? null) as T | null;
  }

  async function findRepositoryId(githubRepoId: number): Promise<string | null> {
    const row = await maybeOne<{ id: string }>(
      "load repository",
      client.from("repositories").select("id").eq("github_repo_id", githubRepoId).maybeSingle(),
    );
    return row?.id ?? null;
  }

  return {
    getConnection: (connectionId) =>
      maybeOne(
        "load GitHub connection",
        client.from("github_connections").select("id, installation_id, suspended_at").eq("id", connectionId)
          .maybeSingle(),
      ),
    async listWorkspaces() {
      return (await maybeOne<WorkspaceRow[]>(
        "list workspaces",
        client.from("workspaces").select(WORKSPACE_COLUMNS).order("created_at", { ascending: false }).order("id"),
      )) ?? [];
    },
    getWorkspace: (workspaceId) =>
      maybeOne(
        "load workspace",
        client.from("workspaces").select(WORKSPACE_COLUMNS).eq("id", workspaceId).maybeSingle(),
      ),
    async findWorkspaceByGithubRepo(githubRepoId) {
      const repositoryId = await findRepositoryId(githubRepoId);
      if (!repositoryId) {
        return null;
      }
      return maybeOne(
        "load workspace",
        client.from("workspaces").select(WORKSPACE_COLUMNS).eq("repository_id", repositoryId).maybeSingle(),
      );
    },
  };
}

export function createWorkspaceWriters(serviceClient: SupabaseClient): WorkspaceWriters {
  async function run<T>(
    action: string,
    op: PromiseLike<{ data: T | null; error: { message: string; code?: string } | null }>,
  ): Promise<T> {
    const { data, error } = await op;
    if (error || data === null) {
      throw new Error(`Failed to ${action}: ${error?.message ?? "no row returned"}`);
    }
    return data;
  }

  return {
    async upsertRepository(userId, repo) {
      const row = await run<{ id: string }>(
        "upsert repository",
        serviceClient
          .from("repositories")
          .upsert({ user_id: userId, ...repo }, { onConflict: "user_id,github_repo_id" })
          .select("id")
          .single(),
      );
      return row.id;
    },
    async insertWorkspace(userId, repositoryId, targetCommitSha) {
      const { data, error } = await serviceClient
        .from("workspaces")
        .insert({ user_id: userId, repository_id: repositoryId, target_commit_sha: targetCommitSha })
        .select("id")
        .single();
      if (error?.code === UNIQUE_VIOLATION) {
        return null;
      }
      if (error || !data) {
        throw new Error(`Failed to insert workspace: ${error?.message ?? "no row returned"}`);
      }
      return data.id as string;
    },
    async attachConnection(userId, repositoryId, connectionId) {
      const { error } = await serviceClient
        .from("repositories")
        .update({ github_connection_id: connectionId })
        .eq("id", repositoryId)
        .eq("user_id", userId)
        .is("github_connection_id", null);
      if (error) {
        throw new Error(`Failed to attach GitHub connection: ${error.message}`);
      }
    },
    async insertIndexingJob(userId, workspaceId) {
      const row = await run<{ id: string }>(
        "insert indexing job",
        serviceClient
          .from("jobs")
          .insert({ user_id: userId, workspace_id: workspaceId, type: "repository_indexing", status: "queued" })
          .select("id")
          .single(),
      );
      return row.id;
    },
    async setJobEventId(userId, jobId, eventId) {
      const { error } = await serviceClient
        .from("jobs")
        .update({ inngest_event_id: eventId })
        .eq("id", jobId)
        .eq("user_id", userId);
      if (error) {
        throw new Error(`Failed to record job event id: ${error.message}`);
      }
    },
  };
}

function toWorkspace(row: WorkspaceRow): Workspace {
  const { github_connection_id: _, ...repository } = row.repository;
  return {
    id: row.id,
    status: row.status,
    repository: { ...repository, html_url: repositoryHtmlUrl(repository.full_name) },
    target_commit_sha: row.target_commit_sha,
    indexed_commit_sha: row.indexed_commit_sha,
    created_at: row.created_at,
    ready_at: row.ready_at,
  };
}

const ROUTE = /\/workspaces(?:\/([^/]+))?\/?$/;

export function createWorkspacesHandler({
  webOrigin,
  authenticate,
  github,
  reader,
  writers,
  jobs,
}: WorkspacesHandlerOptions) {
  const cors = createCors(webOrigin, ["GET", "POST"]);

  function respondWorkspace(row: WorkspaceRow, created: boolean): Response {
    const body = createWorkspaceResponseSchema.parse({ workspace: toWorkspace(row), created });
    return json(body, { status: created ? 201 : 200, headers: cors.headers });
  }

  /** Best effort: the workspace stays `analyzing` if this fails, and the failure is logged. */
  async function startIndexing(
    userId: string,
    workspaceId: string,
    payload: { repository_id: string; commit_sha: string; installation_id: number },
  ): Promise<void> {
    try {
      const jobId = await writers.insertIndexingJob(userId, workspaceId);
      const { eventId } = await jobs.enqueue("repository.index", { workspace_id: workspaceId, ...payload });
      if (eventId !== null) {
        await writers.setJobEventId(userId, jobId, eventId);
      }
    } catch (err) {
      logGithubError(FN, err, {
        event: "workspace_indexing_enqueue_failed",
        code: "internal_error",
        installation_id: payload.installation_id,
        workspace_id: workspaceId,
      });
    }
  }

  async function createWorkspace(req: Request): Promise<Response> {
    const ctx = await authenticate(req);
    if (!ctx) {
      return apiError("unauthorized", cors);
    }

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return apiError("invalid_request", cors);
    }
    const parsed = createWorkspaceRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return apiError("invalid_request", cors);
    }
    const { connection_id: connectionId, github_repo_id: githubRepoId } = parsed.data;
    const userId = ctx.user.id;
    const userReader = reader(ctx.supabase);

    const conn = await userReader.getConnection(connectionId);
    if (!conn) {
      return apiError("connection_not_found", cors);
    }
    if (conn.suspended_at !== null) {
      return apiError("installation_suspended", cors);
    }
    const logCtx = { installation_id: conn.installation_id, connection_id: conn.id };

    // Owner and name always come from GitHub, never from the request.
    let repo: GithubRepo | undefined;
    try {
      const { repositories } = await github.listAllInstallationRepositories(conn.installation_id);
      repo = repositories.find((r) => r.id === githubRepoId);
    } catch (err) {
      logGithubError(FN, err, logCtx);
      return githubErrorResponse(err, cors);
    }
    if (!repo) {
      return apiError("repository_not_accessible", cors);
    }

    const existing = await userReader.findWorkspaceByGithubRepo(githubRepoId);
    if (existing) {
      if (existing.repository.github_connection_id === null) {
        try {
          await writers.attachConnection(userId, existing.repository.id, conn.id);
        } catch (err) {
          logGithubError(FN, err, { ...logCtx, code: "internal_error", workspace_id: existing.id });
        }
      }
      return respondWorkspace(existing, false);
    }

    let commitSha: string;
    try {
      ({ commitSha } = await github.getRepositoryHead(conn.installation_id, repo.owner.login, repo.name));
    } catch (err) {
      logGithubError(FN, err, logCtx);
      return githubErrorResponse(err, cors);
    }

    const repositoryId = await writers.upsertRepository(userId, {
      github_connection_id: conn.id,
      github_repo_id: repo.id,
      owner: repo.owner.login,
      name: repo.name,
      full_name: repo.full_name,
      is_private: repo.private,
      default_branch: repo.default_branch,
    });
    const workspaceId = await writers.insertWorkspace(userId, repositoryId, commitSha);
    if (workspaceId === null) {
      const raced = await userReader.findWorkspaceByGithubRepo(githubRepoId);
      if (!raced) {
        throw new Error("Workspace conflict without an existing workspace");
      }
      return respondWorkspace(raced, false);
    }

    await startIndexing(userId, workspaceId, {
      repository_id: repositoryId,
      commit_sha: commitSha,
      installation_id: conn.installation_id,
    });

    const created = await userReader.getWorkspace(workspaceId);
    if (!created) {
      throw new Error("Created workspace is not readable");
    }
    return respondWorkspace(created, true);
  }

  async function listWorkspaces(req: Request): Promise<Response> {
    const ctx = await authenticate(req);
    if (!ctx) {
      return apiError("unauthorized", cors);
    }
    const rows = await reader(ctx.supabase).listWorkspaces();
    const body = workspaceListResponseSchema.parse({ workspaces: rows.map(toWorkspace) });
    return json(body, { headers: cors.headers });
  }

  async function getWorkspace(req: Request, id: string): Promise<Response> {
    const ctx = await authenticate(req);
    if (!ctx) {
      return apiError("unauthorized", cors);
    }
    if (!workspaceIdParamSchema.safeParse(id).success) {
      return apiError("workspace_not_found", cors);
    }
    const row = await reader(ctx.supabase).getWorkspace(id);
    if (!row) {
      return apiError("workspace_not_found", cors);
    }
    const workspace = toWorkspace(row);
    const body = workspaceDetailResponseSchema.parse({ workspace, repository: workspace.repository, interviews: [] });
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

    const match = new URL(req.url).pathname.match(ROUTE);
    if (!match) {
      return apiError("not_found", cors);
    }
    const id = match[1];
    const allowed = id === undefined ? "GET, POST" : "GET";
    if (!allowed.split(", ").includes(req.method)) {
      return apiError("method_not_allowed", cors, { Allow: `${allowed}, OPTIONS` });
    }

    try {
      if (id !== undefined) {
        return await getWorkspace(req, id);
      }
      return req.method === "POST" ? await createWorkspace(req) : await listWorkspaces(req);
    } catch (err) {
      logGithubError(FN, err, { code: "internal_error" });
      return apiError("internal_error", cors);
    }
  };
}
