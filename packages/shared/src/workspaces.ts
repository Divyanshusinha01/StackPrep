import { z } from "zod";

export const gitCommitShaSchema = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/);

export const workspaceStatusSchema = z.enum(["analyzing", "ready", "failed"]);

export const interviewStatusSchema = z.enum(["created", "in_progress", "paused", "completed", "terminated", "failed"]);

const timestampSchema = z.iso.datetime({ offset: true });

export const workspaceIdParamSchema = z.uuid();

// POST /workspaces -------------------------------------------------------------

export const createWorkspaceRequestSchema = z.strictObject({
  connection_id: z.uuid(),
  github_repo_id: z.int().min(1),
});

export const workspaceRepositorySchema = z.object({
  id: z.uuid(),
  github_repo_id: z.int().min(1),
  owner: z.string().min(1),
  name: z.string().min(1),
  full_name: z.string().min(1),
  is_private: z.boolean(),
  default_branch: z.string().min(1),
  html_url: z.url({ protocol: /^https$/ }),
});

// Repository analysis ------------------------------------------------------------
// Derived from the latest `repository_indexing` job (the Inngest run's persisted projection).

export const analysisStateSchema = z.enum(["queued", "running", "succeeded", "failed"]);

export const analysisStageSchema = z.enum(["scanning", "analyzing", "preparing_context"]);

/** Fixed failure codes recorded on the job; never raw error messages. */
export const analysisErrorCodeSchema = z.enum([
  "installation_unavailable",
  "repository_unavailable",
  "github_rate_limited",
  "github_unavailable",
  "github_unexpected_response",
  "enqueue_failed",
  "internal_error",
]);

export const workspaceAnalysisSchema = z.object({
  state: analysisStateSchema,
  stage: analysisStageSchema.nullable(),
  error_code: analysisErrorCodeSchema.nullable(),
  retryable: z.boolean(),
});

export const workspaceSchema = z.object({
  id: z.uuid(),
  status: workspaceStatusSchema,
  repository: workspaceRepositorySchema,
  target_commit_sha: gitCommitShaSchema.nullable(),
  indexed_commit_sha: gitCommitShaSchema.nullable(),
  created_at: timestampSchema,
  ready_at: timestampSchema.nullable(),
  /** Null when no analysis has been queued for the workspace. */
  analysis: workspaceAnalysisSchema.nullable(),
});

export const createWorkspaceResponseSchema = z.object({
  workspace: workspaceSchema,
  created: z.boolean(),
});

// GET /workspaces --------------------------------------------------------------

export const workspaceListResponseSchema = z.object({
  workspaces: z.array(workspaceSchema),
});

// GET /workspaces/:id ----------------------------------------------------------

export const interviewHistoryItemSchema = z.object({
  id: z.uuid(),
  interview_number: z.int().min(1),
  status: interviewStatusSchema,
  started_at: timestampSchema.nullable(),
  ended_at: timestampSchema.nullable(),
  created_at: timestampSchema,
});

export const workspaceDetailResponseSchema = z.object({
  workspace: workspaceSchema,
  repository: workspaceRepositorySchema,
  interviews: z.array(interviewHistoryItemSchema),
});

// POST /workspaces/:id/analysis/retry ----------------------------------------------

export const retryAnalysisResponseSchema = z.object({
  workspace: workspaceSchema,
});

// POST /workspaces/:id/interviews ----------------------------------------------------
// Planning state is derived from the interview's latest `interview_planning` job.

export const planningStateSchema = z.enum(["queued", "running", "succeeded", "failed"]);

/** Fixed failure codes recorded on the planning job; never raw error messages. */
export const planningErrorCodeSchema = z.enum([
  "repository_memory_unavailable",
  "ai_rate_limited",
  "ai_unavailable",
  "ai_invalid_output",
  "enqueue_failed",
  "internal_error",
]);

export const interviewPlanningSchema = z.object({
  state: planningStateSchema,
  error_code: planningErrorCodeSchema.nullable(),
});

export const createInterviewResponseSchema = z.object({
  interview: interviewHistoryItemSchema,
  planning: interviewPlanningSchema,
});

/** `repositories` has no html_url column; GitHub's canonical URL is derived from the full name. */
export function repositoryHtmlUrl(fullName: string): string {
  return `https://github.com/${fullName.split("/").map(encodeURIComponent).join("/")}`;
}

export type WorkspaceStatus = z.infer<typeof workspaceStatusSchema>;
export type AnalysisState = z.infer<typeof analysisStateSchema>;
export type AnalysisStage = z.infer<typeof analysisStageSchema>;
export type AnalysisErrorCode = z.infer<typeof analysisErrorCodeSchema>;
export type WorkspaceAnalysis = z.infer<typeof workspaceAnalysisSchema>;
export type RetryAnalysisResponse = z.infer<typeof retryAnalysisResponseSchema>;
export type CreateWorkspaceRequest = z.infer<typeof createWorkspaceRequestSchema>;
export type WorkspaceRepository = z.infer<typeof workspaceRepositorySchema>;
export type Workspace = z.infer<typeof workspaceSchema>;
export type CreateWorkspaceResponse = z.infer<typeof createWorkspaceResponseSchema>;
export type WorkspaceListResponse = z.infer<typeof workspaceListResponseSchema>;
export type InterviewHistoryItem = z.infer<typeof interviewHistoryItemSchema>;
export type WorkspaceDetailResponse = z.infer<typeof workspaceDetailResponseSchema>;
export type InterviewStatus = z.infer<typeof interviewStatusSchema>;
export type PlanningState = z.infer<typeof planningStateSchema>;
export type PlanningErrorCode = z.infer<typeof planningErrorCodeSchema>;
export type InterviewPlanning = z.infer<typeof interviewPlanningSchema>;
export type CreateInterviewResponse = z.infer<typeof createInterviewResponseSchema>;
