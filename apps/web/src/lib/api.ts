import {
  type ApiErrorCode,
  apiErrorSchema,
  type ConnectGithubRequest,
  connectGithubResponseSchema,
  createInterviewResponseSchema,
  type CreateWorkspaceRequest,
  createWorkspaceResponseSchema,
  gitCommitShaSchema,
  healthResponseSchema,
  interviewHistoryItemSchema,
  type InterviewPlanning,
  planningErrorCodeSchema,
  planningStateSchema,
  repositoryListResponseSchema,
  retryAnalysisResponseSchema,
  workspaceDetailResponseSchema,
  workspaceIdParamSchema,
  workspaceListResponseSchema,
  workspaceRepositorySchema,
  workspaceSchema,
} from "@stackprep/shared";
import { FunctionsHttpError } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "@/lib/supabase/server";

interface Schema<T> {
  parse(data: unknown): T;
}

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: ApiErrorCode; nextAvailableAt?: string };

async function functionGet<T>(name: string, schema: Schema<T>): Promise<T> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.functions.invoke(name, { method: "GET" });
  if (error) {
    throw new Error(`Edge Function ${name} failed: ${error.message}`);
  }
  return schema.parse(data);
}

/** Like `functionGet`, but maps the backend's `{ error, code }` responses to a typed result instead of throwing. */
async function functionRequest<T>(
  name: string,
  schema: Schema<T>,
  init: { method: "GET" | "POST"; body?: Record<string, unknown> },
): Promise<ApiResult<T>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.functions.invoke(name, init);
  if (!error) {
    return { ok: true, data: schema.parse(data) };
  }
  if (error instanceof FunctionsHttpError) {
    const body = await (error.context as Response).json().catch(() => null);
    const parsed = apiErrorSchema.safeParse(body);
    if (parsed.success) {
      const { code, next_available_at: nextAvailableAt } = parsed.data;
      return nextAvailableAt ? { ok: false, code, nextAvailableAt } : { ok: false, code };
    }
  }
  return { ok: false, code: "github_unavailable" };
}

export function getHealth() {
  return functionGet("health", healthResponseSchema);
}

export function connectGithub(body: ConnectGithubRequest) {
  return functionRequest("github/connect", connectGithubResponseSchema, { method: "POST", body });
}

export function listRepositories(page = 1) {
  return functionRequest(`repositories?page=${page}&per_page=100`, repositoryListResponseSchema, { method: "GET" });
}

export function createWorkspace(body: CreateWorkspaceRequest) {
  return functionRequest("workspaces", createWorkspaceResponseSchema, { method: "POST", body });
}

export function listWorkspaces() {
  return functionRequest("workspaces", workspaceListResponseSchema, { method: "GET" });
}

export function getWorkspace(id: string) {
  return functionRequest(`workspaces/${encodeURIComponent(id)}`, workspaceDetailResponseSchema, { method: "GET" });
}

export function retryWorkspaceAnalysis(id: string) {
  return functionRequest(`workspaces/${encodeURIComponent(id)}/analysis/retry`, retryAnalysisResponseSchema, {
    method: "POST",
  });
}

const interviewRowSchema = interviewHistoryItemSchema.extend({
  workspace_id: workspaceIdParamSchema,
  repository_commit_sha: gitCommitShaSchema,
  workspace: workspaceSchema.pick({}).extend({ repository: workspaceRepositorySchema.pick({ full_name: true }) }),
});

export type InterviewDetail = Omit<ReturnType<typeof interviewRowSchema.parse>, "workspace"> & {
  repository_full_name: string;
  /** Null only if the planning job row is missing. */
  planning: InterviewPlanning | null;
};

/**
 * Reads the interview and its latest planning job with the user's own session, so RLS limits it
 * to their rows. There is no documented `GET /interviews/:id`; hidden state is never selectable.
 */
export async function getInterview(id: string): Promise<InterviewDetail | null> {
  if (!workspaceIdParamSchema.safeParse(id).success) {
    return null;
  }
  const supabase = await createSupabaseServerClient();
  const [interview, job] = await Promise.all([
    supabase
      .from("interviews")
      .select(
        "id, workspace_id, interview_number, status, started_at, ended_at, created_at, repository_commit_sha, " +
          "workspace:workspaces!interviews_workspace_id_user_id_fkey" +
          "(repository:repositories!workspaces_repository_id_user_id_fkey(full_name))",
      )
      .eq("id", id)
      .maybeSingle(),
    supabase
      .from("jobs")
      .select("status, error_code")
      .eq("interview_id", id)
      .eq("type", "interview_planning")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (interview.error) {
    throw new Error(`Failed to load interview: ${interview.error.message}`);
  }
  if (job.error) {
    throw new Error(`Failed to load interview planning: ${job.error.message}`);
  }
  if (!interview.data) {
    return null;
  }
  const { workspace, ...row } = interviewRowSchema.parse(interview.data);
  let planning: InterviewPlanning | null = null;
  if (job.data) {
    const { status, error_code: errorCode } = job.data as { status: unknown; error_code: unknown };
    const state = planningStateSchema.parse(status);
    const code = planningErrorCodeSchema.safeParse(errorCode);
    planning = { state, error_code: state === "failed" ? (code.success ? code.data : "internal_error") : null };
  }
  return { ...row, repository_full_name: workspace.repository.full_name, planning };
}

export function createInterview(workspaceId: string) {
  return functionRequest(`workspaces/${encodeURIComponent(workspaceId)}/interviews`, createInterviewResponseSchema, {
    method: "POST",
  });
}
