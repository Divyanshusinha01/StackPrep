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

export const workspaceSchema = z.object({
  id: z.uuid(),
  status: workspaceStatusSchema,
  repository: workspaceRepositorySchema,
  target_commit_sha: gitCommitShaSchema.nullable(),
  indexed_commit_sha: gitCommitShaSchema.nullable(),
  created_at: timestampSchema,
  ready_at: timestampSchema.nullable(),
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

/** `repositories` has no html_url column; GitHub's canonical URL is derived from the full name. */
export function repositoryHtmlUrl(fullName: string): string {
  return `https://github.com/${fullName.split("/").map(encodeURIComponent).join("/")}`;
}

export type WorkspaceStatus = z.infer<typeof workspaceStatusSchema>;
export type CreateWorkspaceRequest = z.infer<typeof createWorkspaceRequestSchema>;
export type WorkspaceRepository = z.infer<typeof workspaceRepositorySchema>;
export type Workspace = z.infer<typeof workspaceSchema>;
export type CreateWorkspaceResponse = z.infer<typeof createWorkspaceResponseSchema>;
export type WorkspaceListResponse = z.infer<typeof workspaceListResponseSchema>;
export type InterviewHistoryItem = z.infer<typeof interviewHistoryItemSchema>;
export type WorkspaceDetailResponse = z.infer<typeof workspaceDetailResponseSchema>;
