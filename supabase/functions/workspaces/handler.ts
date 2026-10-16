import {
  type AnalysisErrorCode,
  analysisErrorCodeSchema,
  analysisStageSchema,
  type AnalysisState,
  createInterviewResponseSchema,
  createWorkspaceRequestSchema,
  createWorkspaceResponseSchema,
  type InterviewHistoryItem,
  type InterviewPlanning,
  type InterviewStatus,
  type OpenAIKeyStatus,
  type PlanningErrorCode,
  repositoryHtmlUrl,
  retryAnalysisResponseSchema,
  type Workspace,
  type WorkspaceAnalysis,
  workspaceDetailResponseSchema,
  workspaceIdParamSchema,
  workspaceListResponseSchema,
  type WorkspaceStatus,
} from "@stackprep/shared";
import type { SupabaseClient } from "@supabase/supabase-js";
import { keyStatusApiErrorCode } from "../_shared/ai/clients.ts";
import { createOpenAICredentialStore } from "../_shared/ai/credentials.ts";
import type { Authenticate } from "../_shared/auth.ts";
import type { GithubApp, GithubRepo } from "../_shared/github-app.ts";
import { apiError, githubErrorResponse, logGithubError } from "../_shared/github-errors.ts";
import { createCors, json } from "../_shared/http.ts";
import type { JobQueue } from "../_shared/jobs.ts";

const FN = "workspaces";
const UNIQUE_VIOLATION = "23505";

const ENQUEUE_FAILED_MESSAGE = "The analysis could not be queued";
const PLANNING_ENQUEUE_FAILED_MESSAGE = "Interview planning could not be queued";

const INTERVIEW_COLUMNS = "id, interview_number, status, started_at, ended_at, created_at";

/** Only the latest repository_indexing job is embedded (see `withLatestJob`). */
const WORKSPACE_COLUMNS = "id, status, target_commit_sha, indexed_commit_sha, created_at, ready_at, " +
  "repository:repositories!workspaces_repository_id_user_id_fkey" +
  "(id, github_repo_id, owner, name, full_name, is_private, default_branch, github_connection_id), " +
  "analysis_jobs:jobs!jobs_workspace_id_user_id_fkey(status, stage, error_code, type, created_at)";

export interface AnalysisJobRow {
  status: AnalysisState;
  stage: string | null;
  error_code: string | null;
}

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
  /** At most one row: the latest repository_indexing job. */
  analysis_jobs: AnalysisJobRow[];
}

/** Reads made with the caller's client, so RLS limits every result to their own rows. */
export interface WorkspaceReader {
  getConnection(connectionId: string): Promise<ConnectionRow | null>;
  listWorkspaces(): Promise<WorkspaceRow[]>;
  getWorkspace(workspaceId: string): Promise<WorkspaceRow | null>;
  findWorkspaceByGithubRepo(githubRepoId: number): Promise<WorkspaceRow | null>;
  /** Newest first. */
  listInterviews(workspaceId: string): Promise<InterviewHistoryItem[]>;
}

export interface StartedInterview {
  interview_id: string;
  interview_number: number;
  status: InterviewStatus;
  created_at: string;
  job_id: string;
}

export type StartInterviewResult =
  | { ok: true; interview: StartedInterview }
  | { ok: false; reason: "workspace_not_found" | "workspace_not_ready" }
  | { ok: false; reason: "interview_limit_reached"; next_available_at: string };

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
  insertIndexingJob(userId: string, workspaceId: string, commitSha: string): Promise<string>;
  setJobEventId(userId: string, jobId: string, eventId: string): Promise<void>;
  /** Marks the job (and its workspace) failed so the user can retry. */
  failIndexingJob(workspaceId: string, jobId: string, code: AnalysisErrorCode, message: string): Promise<void>;
  /** Atomically re-queues a failed workspace; null when it is not the user's or not failed. */
  retryAnalysis(userId: string, workspaceId: string): Promise<string | null>;
  /**
   * Atomically checks ownership, readiness at `commitSha`, and the rolling usage limit, then
   * creates the interview, its empty state, and a queued planning job.
   */
  startInterview(userId: string, workspaceId: string, commitSha: string): Promise<StartInterviewResult>;
  failPlanningJob(userId: string, jobId: string, code: PlanningErrorCode, message: string): Promise<void>;
  /** Status of the user's stored OpenAI key; null when none is stored. */
  getOpenAIKeyStatus(userId: string): Promise<OpenAIKeyStatus | null>;
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

  function workspaces() {
    return client
      .from("workspaces")
      .select(WORKSPACE_COLUMNS)
      .eq("analysis_jobs.type", "repository_indexing")
      .order("created_at", { referencedTable: "analysis_jobs", ascending: false })
      .limit(1, { referencedTable: "analysis_jobs" });
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
        workspaces().order("created_at", { ascending: false }).order("id"),
      )) ?? [];
    },
    getWorkspace: (workspaceId) =>
      maybeOne(
        "load workspace",
        workspaces().eq("id", workspaceId).maybeSingle(),
      ),
    async findWorkspaceByGithubRepo(githubRepoId) {
      const repositoryId = await findRepositoryId(githubRepoId);
      if (!repositoryId) {
        return null;
      }
      return maybeOne(
        "load workspace",
        workspaces().eq("repository_id", repositoryId).maybeSingle(),
      );
    },
    async listInterviews(workspaceId) {
      return (await maybeOne<InterviewHistoryItem[]>(
        "list interviews",
        client.from("interviews").select(INTERVIEW_COLUMNS).eq("workspace_id", workspaceId)
          .order("interview_number", { ascending: false }),
      )) ?? [];
    },
  };
}

const WORKSPACE_NOT_FOUND_SQLSTATE = "P0002";
const WORKSPACE_NOT_READY_SQLSTATE = "55000";
const INTERVIEW_LIMIT_SQLSTATE = "P0429";

export function createWorkspaceWriters(serviceClient: SupabaseClient): WorkspaceWriters {
  const keyStatuses = createOpenAICredentialStore(serviceClient);

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
    async insertIndexingJob(userId, workspaceId, commitSha) {
      const row = await run<{ id: string }>(
        "insert indexing job",
        serviceClient
          .from("jobs")
          .insert({
            user_id: userId,
            workspace_id: workspaceId,
            type: "repository_indexing",
            status: "queued",
            repository_commit_sha: commitSha,
          })
          .select("id")
          .single(),
      );
      return row.id;
    },
    async failIndexingJob(workspaceId, jobId, code, message) {
      const { error } = await serviceClient.rpc("fail_repository_analysis", {
        p_workspace_id: workspaceId,
        p_job_id: jobId,
        p_error_code: code,
        p_error_message: message,
      });
      if (error) {
        throw new Error(`Failed to record indexing failure: ${error.message}`);
      }
    },
    async retryAnalysis(userId, workspaceId) {
      const { data, error } = await serviceClient.rpc("retry_repository_analysis", {
        p_workspace_id: workspaceId,
        p_user_id: userId,
      });
      if (error?.code === UNIQUE_VIOLATION) {
        return null;
      }
      if (error) {
        throw new Error(`Failed to retry repository analysis: ${error.message}`);
      }
      return (data as string | null) ?? null;
    },
    async startInterview(userId, workspaceId, commitSha) {
      const { data, error } = await serviceClient.rpc("start_interview", {
        p_workspace_id: workspaceId,
        p_user_id: userId,
        p_commit_sha: commitSha,
      });
      if (error?.code === WORKSPACE_NOT_FOUND_SQLSTATE) {
        return { ok: false, reason: "workspace_not_found" };
      }
      if (error?.code === WORKSPACE_NOT_READY_SQLSTATE) {
        return { ok: false, reason: "workspace_not_ready" };
      }
      if (error?.code === INTERVIEW_LIMIT_SQLSTATE) {
        const nextAt = new Date(error.details ?? "");
        if (Number.isNaN(nextAt.getTime())) {
          throw new Error("Interview limit error without a next-available time");
        }
        return { ok: false, reason: "interview_limit_reached", next_available_at: nextAt.toISOString() };
      }
      if (error) {
        throw new Error(`Failed to start interview: ${error.message}`);
      }
      const row = (data as StartedInterview[] | null)?.[0];
      if (!row) {
        throw new Error("Failed to start interview: no row returned");
      }
      return { ok: true, interview: row };
    },
    async failPlanningJob(userId, jobId, code, message) {
      const { error } = await serviceClient
        .from("jobs")
        .update({ status: "failed", error_code: code, error_message: message, finished_at: new Date().toISOString() })
        .eq("id", jobId)
        .eq("user_id", userId)
        .eq("type", "interview_planning")
        .neq("status", "succeeded");
      if (error) {
        throw new Error(`Failed to record planning failure: ${error.message}`);
      }
    },
    async getOpenAIKeyStatus(userId) {
      return (await keyStatuses.getStatus(userId))?.status ?? null;
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

/** Unknown stored values degrade to null / internal_error instead of failing the response. */
export function toAnalysis(job: AnalysisJobRow | undefined, status: WorkspaceStatus): WorkspaceAnalysis | null {
  if (!job) {
    return null;
  }
  const stage = analysisStageSchema.safeParse(job.stage);
  const failed = job.status === "failed";
  const code = failed ? analysisErrorCodeSchema.safeParse(job.error_code) : null;
  return {
    state: job.status,
    stage: job.status === "running" && stage.success ? stage.data : null,
    error_code: code ? (code.success ? code.data : "internal_error") : null,
    retryable: failed && status === "failed",
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
    analysis: toAnalysis(row.analysis_jobs?.[0], row.status),
  };
}

const ROUTE = /\/workspaces(?:\/([^/]+)(\/analysis\/retry|\/interviews)?)?\/?$/;

export function createWorkspacesHandler({
  webOrigin,
  authenticate,
  github,
  reader,
  writers,
  jobs,
}: WorkspacesHandlerOptions) {
  const cors = createCors(webOrigin, ["GET", "POST"]);

  /** Analysis, planning, and embeddings run on the user's own key, so nothing is queued without one. */
  async function keyGate(userId: string): Promise<Response | null> {
    const code = keyStatusApiErrorCode(await writers.getOpenAIKeyStatus(userId));
    return code ? apiError(code, cors) : null;
  }

  function respondWorkspace(row: WorkspaceRow, created: boolean): Response {
    const body = createWorkspaceResponseSchema.parse({ workspace: toWorkspace(row), created });
    return json(body, { status: created ? 201 : 200, headers: cors.headers });
  }

  /**
   * Best effort and never throws. If the event cannot be sent, the job and workspace are marked
   * failed (`enqueue_failed`) so the user can retry instead of waiting on a run that never starts.
   */
  async function enqueueAnalysis(
    userId: string,
    workspaceId: string,
    jobId: string,
    payload: { repository_id: string; commit_sha: string; installation_id: number },
  ): Promise<void> {
    const logCtx = { installation_id: payload.installation_id, workspace_id: workspaceId };
    let eventId: string | null;
    try {
      ({ eventId } = await jobs.enqueue("repository.analysis.requested", {
        workspace_id: workspaceId,
        job_id: jobId,
        ...payload,
      }));
    } catch (err) {
      logGithubError(FN, err, { ...logCtx, event: "workspace_indexing_enqueue_failed", code: "internal_error" });
      try {
        await writers.failIndexingJob(workspaceId, jobId, "enqueue_failed", ENQUEUE_FAILED_MESSAGE);
      } catch (failErr) {
        logGithubError(FN, failErr, { ...logCtx, event: "workspace_indexing_fail_record_failed", code: "internal_error" });
      }
      return;
    }
    if (eventId !== null) {
      try {
        await writers.setJobEventId(userId, jobId, eventId);
      } catch (err) {
        logGithubError(FN, err, { ...logCtx, event: "workspace_job_event_id_failed", code: "internal_error" });
      }
    }
  }

  /** Best effort: the workspace stays `analyzing` if the job row cannot be created, and the failure is logged. */
  async function startIndexing(
    userId: string,
    workspaceId: string,
    payload: { repository_id: string; commit_sha: string; installation_id: number },
  ): Promise<void> {
    let jobId: string;
    try {
      jobId = await writers.insertIndexingJob(userId, workspaceId, payload.commit_sha);
    } catch (err) {
      logGithubError(FN, err, {
        event: "workspace_indexing_enqueue_failed",
        code: "internal_error",
        installation_id: payload.installation_id,
        workspace_id: workspaceId,
      });
      return;
    }
    await enqueueAnalysis(userId, workspaceId, jobId, payload);
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

    const blocked = await keyGate(userId);
    if (blocked) {
      return blocked;
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
    const userReader = reader(ctx.supabase);
    const row = await userReader.getWorkspace(id);
    if (!row) {
      return apiError("workspace_not_found", cors);
    }
    const workspace = toWorkspace(row);
    const interviews = await userReader.listInterviews(row.id);
    const body = workspaceDetailResponseSchema.parse({ workspace, repository: workspace.repository, interviews });
    return json(body, { headers: cors.headers });
  }

  /**
   * Best effort and never throws. If the event cannot be sent, the planning job is marked failed
   * (`enqueue_failed`) instead of leaving the interview waiting on a run that never starts.
   */
  async function enqueuePlanning(
    userId: string,
    workspaceId: string,
    interview: StartedInterview,
    commitSha: string,
  ): Promise<InterviewPlanning> {
    const logCtx = { workspace_id: workspaceId, interview_id: interview.interview_id };
    let eventId: string | null;
    try {
      ({ eventId } = await jobs.enqueue("interview.planning.requested", {
        interview_id: interview.interview_id,
        workspace_id: workspaceId,
        job_id: interview.job_id,
        commit_sha: commitSha,
      }));
    } catch (err) {
      logGithubError(FN, err, { ...logCtx, event: "interview_planning_enqueue_failed", code: "internal_error" });
      try {
        await writers.failPlanningJob(userId, interview.job_id, "enqueue_failed", PLANNING_ENQUEUE_FAILED_MESSAGE);
      } catch (failErr) {
        logGithubError(FN, failErr, { ...logCtx, event: "interview_planning_fail_record_failed", code: "internal_error" });
      }
      return { state: "failed", error_code: "enqueue_failed" };
    }
    if (eventId !== null) {
      try {
        await writers.setJobEventId(userId, interview.job_id, eventId);
      } catch (err) {
        logGithubError(FN, err, { ...logCtx, event: "interview_job_event_id_failed", code: "internal_error" });
      }
    }
    return { state: "queued", error_code: null };
  }

  async function createInterview(req: Request, id: string): Promise<Response> {
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
    if (row.status !== "ready" || row.indexed_commit_sha === null) {
      return apiError("workspace_not_ready", cors);
    }
    const blocked = await keyGate(ctx.user.id);
    if (blocked) {
      return blocked;
    }

    const commitSha = row.indexed_commit_sha;
    const result = await writers.startInterview(ctx.user.id, row.id, commitSha);
    if (!result.ok) {
      if (result.reason === "interview_limit_reached") {
        const seconds = Math.max(1, Math.ceil((Date.parse(result.next_available_at) - Date.now()) / 1000));
        return apiError("interview_limit_reached", cors, { "Retry-After": String(seconds) }, {
          next_available_at: result.next_available_at,
        });
      }
      return apiError(result.reason, cors);
    }

    const { interview } = result;
    const planning = await enqueuePlanning(ctx.user.id, row.id, interview, commitSha);
    const body = createInterviewResponseSchema.parse({
      interview: {
        id: interview.interview_id,
        interview_number: interview.interview_number,
        status: interview.status,
        started_at: null,
        ended_at: null,
        created_at: interview.created_at,
      },
      planning,
    });
    return json(body, { status: 201, headers: cors.headers });
  }

  async function retryAnalysis(req: Request, id: string): Promise<Response> {
    const ctx = await authenticate(req);
    if (!ctx) {
      return apiError("unauthorized", cors);
    }
    if (!workspaceIdParamSchema.safeParse(id).success) {
      return apiError("workspace_not_found", cors);
    }
    const userReader = reader(ctx.supabase);
    const row = await userReader.getWorkspace(id);
    if (!row) {
      return apiError("workspace_not_found", cors);
    }
    if (row.status !== "failed" || row.target_commit_sha === null) {
      return apiError("analysis_not_retryable", cors);
    }
    const connectionId = row.repository.github_connection_id;
    const conn = connectionId ? await userReader.getConnection(connectionId) : null;
    if (!conn) {
      return apiError("connection_not_found", cors);
    }
    if (conn.suspended_at !== null) {
      return apiError("installation_suspended", cors);
    }
    const blocked = await keyGate(ctx.user.id);
    if (blocked) {
      return blocked;
    }

    const jobId = await writers.retryAnalysis(ctx.user.id, row.id);
    if (jobId === null) {
      return apiError("analysis_not_retryable", cors);
    }
    await enqueueAnalysis(ctx.user.id, row.id, jobId, {
      repository_id: row.repository.id,
      commit_sha: row.target_commit_sha,
      installation_id: conn.installation_id,
    });

    const updated = await userReader.getWorkspace(row.id);
    if (!updated) {
      throw new Error("Retried workspace is not readable");
    }
    const body = retryAnalysisResponseSchema.parse({ workspace: toWorkspace(updated) });
    return json(body, { status: 202, headers: cors.headers });
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
    const action = match[2];
    const allowed = id === undefined ? "GET, POST" : action !== undefined ? "POST" : "GET";
    if (!allowed.split(", ").includes(req.method)) {
      return apiError("method_not_allowed", cors, { Allow: `${allowed}, OPTIONS` });
    }

    try {
      if (action === "/analysis/retry") {
        return await retryAnalysis(req, id);
      }
      if (action === "/interviews") {
        return await createInterview(req, id);
      }
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
