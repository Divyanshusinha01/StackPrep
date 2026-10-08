import {
  type ApiErrorCode,
  apiErrorSchema,
  type ConnectGithubRequest,
  connectGithubResponseSchema,
  createInterviewResponseSchema,
  type CreateWorkspaceRequest,
  createWorkspaceResponseSchema,
  deleteInterviewResponseSchema,
  gitCommitShaSchema,
  healthResponseSchema,
  interviewHistoryItemSchema,
  type InterviewPlanning,
  interviewReportResponseSchema,
  interviewStatusSchema,
  PAUSE_RESUME_WINDOW_SECONDS,
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
import { cache } from "react";
import { z } from "zod";
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
  init: { method: "GET" | "POST" | "DELETE"; body?: Record<string, unknown> },
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

/** Cached per request so a segment layout and its page share one call. */
export const getWorkspace = cache((id: string) =>
  functionRequest(`workspaces/${encodeURIComponent(id)}`, workspaceDetailResponseSchema, { method: "GET" }),
);

export function retryWorkspaceAnalysis(id: string) {
  return functionRequest(`workspaces/${encodeURIComponent(id)}/analysis/retry`, retryAnalysisResponseSchema, {
    method: "POST",
  });
}

const interviewRowSchema = interviewHistoryItemSchema.extend({
  workspace_id: workspaceIdParamSchema,
  repository_commit_sha: gitCommitShaSchema,
  paused_at: z.string().nullable(),
  pause_count: z.int().min(0),
  termination_reason: z.string().nullable(),
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
 * Cached per request so a segment layout and its page share one read.
 */
export const getInterview = cache(async (id: string): Promise<InterviewDetail | null> => {
  if (!workspaceIdParamSchema.safeParse(id).success) {
    return null;
  }
  const supabase = await createSupabaseServerClient();
  const [interview, job] = await Promise.all([
    supabase
      .from("interviews")
      .select(
        "id, workspace_id, interview_number, status, started_at, ended_at, created_at, repository_commit_sha, " +
          "paused_at, pause_count, termination_reason, " +
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
});

export function createInterview(workspaceId: string) {
  return functionRequest(`workspaces/${encodeURIComponent(workspaceId)}/interviews`, createInterviewResponseSchema, {
    method: "POST",
  });
}

export function getInterviewReport(id: string) {
  return functionRequest(`interviews/${encodeURIComponent(id)}/report`, interviewReportResponseSchema, { method: "GET" });
}

export function retryInterviewReport(id: string) {
  return functionRequest(`interviews/${encodeURIComponent(id)}/report/retry`, interviewReportResponseSchema, {
    method: "POST",
  });
}

export function deleteInterview(id: string) {
  return functionRequest(`interviews/${encodeURIComponent(id)}`, deleteInterviewResponseSchema, { method: "DELETE" });
}

const transcriptEntrySchema = z.object({
  id: z.uuid(),
  sequence: z.int().min(1),
  role: z.enum(["ai", "user"]),
  content: z.string(),
  created_at: z.string(),
});

export type TranscriptEntry = z.infer<typeof transcriptEntrySchema>;

/** The stored transcript (interviewer and candidate turns), read with RLS; the source of truth for reports. */
export async function getInterviewTranscript(id: string): Promise<TranscriptEntry[]> {
  if (!workspaceIdParamSchema.safeParse(id).success) {
    return [];
  }
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("interview_messages")
    .select("id, sequence, role, content, created_at")
    .eq("interview_id", id)
    .in("role", ["ai", "user"])
    .order("sequence");
  if (error) {
    throw new Error(`Failed to load transcript: ${error.message}`);
  }
  return z.array(transcriptEntrySchema).parse(data ?? []);
}

/** `none`: the interview did not complete, so no report is generated. */
export type ReportAvailability = "ready" | "generating" | "failed" | "none";

const historyRowSchema = z.object({
  id: z.uuid(),
  workspace_id: z.uuid(),
  interview_number: z.int().min(1),
  status: interviewStatusSchema,
  termination_reason: z.string().nullable(),
  created_at: z.string(),
  started_at: z.string().nullable(),
  ended_at: z.string().nullable(),
  paused_at: z.string().nullable(),
  workspace: z.object({ repository: z.object({ full_name: z.string() }) }),
  report: z.union([z.object({ generated_at: z.string() }), z.array(z.object({ generated_at: z.string() }))]).nullable(),
  report_jobs: z.array(z.object({ status: planningStateSchema })),
});

export type InterviewHistoryEntry = Omit<z.infer<typeof historyRowSchema>, "workspace" | "report" | "report_jobs" | "paused_at"> & {
  report: ReportAvailability;
  /** Only for a paused interview: when it must be resumed by, or `expired` once that has passed. */
  pause: { resumeBy: string } | "expired" | null;
};

function pauseState(row: z.infer<typeof historyRowSchema>, now: number): InterviewHistoryEntry["pause"] {
  if (row.status !== "paused" || !row.paused_at) {
    return null;
  }
  const resumeBy = Date.parse(row.paused_at) + PAUSE_RESUME_WINDOW_SECONDS * 1000;
  return resumeBy > now ? { resumeBy: new Date(resumeBy).toISOString() } : "expired";
}

export interface InterviewHistoryGroup {
  workspace_id: string;
  repository_full_name: string;
  interviews: InterviewHistoryEntry[];
}

function reportAvailability(row: z.infer<typeof historyRowSchema>): ReportAvailability {
  const hasReport = Array.isArray(row.report) ? row.report.length > 0 : row.report !== null;
  if (hasReport) {
    return "ready";
  }
  if (row.status !== "completed") {
    return "none";
  }
  const job = row.report_jobs[0];
  return job && (job.status === "queued" || job.status === "running") ? "generating" : "failed";
}

/**
 * Interviews with report availability, grouped by repository workspace (newest first). Read with
 * the user's own session, so RLS limits it to their rows; hidden state is never selected.
 */
export async function getInterviewHistory(workspaceId?: string): Promise<InterviewHistoryGroup[]> {
  const supabase = await createSupabaseServerClient();
  let query = supabase
    .from("interviews")
    .select(
      "id, workspace_id, interview_number, status, termination_reason, created_at, started_at, ended_at, paused_at, " +
        "workspace:workspaces!interviews_workspace_id_user_id_fkey" +
        "(repository:repositories!workspaces_repository_id_user_id_fkey(full_name)), " +
        "report:reports!reports_interview_id_workspace_id_user_id_fkey(generated_at), " +
        "report_jobs:jobs!jobs_interview_id_workspace_id_user_id_fkey(status, created_at)",
    )
    .eq("report_jobs.type", "report_generation")
    .order("created_at", { referencedTable: "report_jobs", ascending: false })
    .limit(1, { referencedTable: "report_jobs" })
    .order("created_at", { ascending: false });
  if (workspaceId) {
    query = query.eq("workspace_id", workspaceId);
  }
  const { data, error } = await query;
  if (error) {
    throw new Error(`Failed to load interview history: ${error.message}`);
  }

  const now = Date.now();
  const groups = new Map<string, InterviewHistoryGroup>();
  for (const row of z.array(historyRowSchema).parse(data ?? [])) {
    const group = groups.get(row.workspace_id) ?? {
      workspace_id: row.workspace_id,
      repository_full_name: row.workspace.repository.full_name,
      interviews: [],
    };
    group.interviews.push({
      id: row.id,
      workspace_id: row.workspace_id,
      interview_number: row.interview_number,
      status: row.status,
      termination_reason: row.termination_reason,
      created_at: row.created_at,
      started_at: row.started_at,
      ended_at: row.ended_at,
      pause: pauseState(row, now),
      report: reportAvailability(row),
    });
    groups.set(row.workspace_id, group);
  }
  return [...groups.values()];
}
