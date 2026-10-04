import { z } from "zod";

export const MAX_REPOS_PER_INSTALLATION = 1000;

export const apiErrorCodeSchema = z.enum([
  "method_not_allowed",
  "not_found",
  "invalid_request",
  "unauthorized",
  "invalid_oauth_code",
  "github_account_mismatch",
  "installation_not_accessible",
  "unsupported_installation_account",
  "installation_suspended",
  "connection_not_found",
  "repository_not_accessible",
  "workspace_not_found",
  "github_rate_limited",
  "github_unavailable",
  "github_unexpected_response",
  "internal_error",
]);

export const apiErrorSchema = z.object({
  error: z.string().min(1),
  code: apiErrorCodeSchema,
});

// POST /github/connect ---------------------------------------------------------

export const connectGithubRequestSchema = z.strictObject({
  code: z
    .string()
    .trim()
    .min(1)
    .max(512)
    .regex(/^[A-Za-z0-9_-]+$/),
  installation_id: z.int().min(1),
});

export const githubConnectionSchema = z.object({
  id: z.uuid(),
  account_login: z.string().min(1),
  account_type: z.enum(["User", "Organization"]),
  repository_selection: z.enum(["all", "selected"]),
  suspended: z.boolean(),
});

export const connectGithubResponseSchema = z.object({
  connection: githubConnectionSchema,
});

// GET /repositories ------------------------------------------------------------

export const repositoryListQuerySchema = z.strictObject({
  page: z
    .string()
    .regex(/^[1-9][0-9]{0,3}$/)
    .transform(Number)
    .pipe(z.int().min(1).max(1000))
    .default(1),
  per_page: z
    .string()
    .regex(/^[1-9][0-9]{0,2}$/)
    .transform(Number)
    .pipe(z.int().min(1).max(100))
    .default(30),
  connection_id: z.uuid().optional(),
});

export const repositorySchema = z.object({
  id: z.int().min(1),
  connection_id: z.uuid(),
  owner: z.string().min(1),
  name: z.string().min(1),
  full_name: z.string().min(1),
  is_private: z.boolean(),
  default_branch: z.string().min(1),
  html_url: z.url({ protocol: /^https$/ }),
});

export const connectionErrorCodeSchema = z.enum([
  "github_rate_limited",
  "github_unavailable",
  "github_unexpected_response",
]);

export const connectionStatusSchema = z.discriminatedUnion("status", [
  z.object({
    id: z.uuid(),
    account_login: z.string().min(1),
    status: z.enum(["ok", "suspended", "removed"]),
  }),
  z.object({
    id: z.uuid(),
    account_login: z.string().min(1),
    status: z.literal("error"),
    code: connectionErrorCodeSchema,
  }),
]);

export const repositoryListResponseSchema = z.object({
  connected: z.boolean(),
  repositories: z.array(repositorySchema),
  connections: z.array(connectionStatusSchema),
  page: z.int().min(1),
  per_page: z.int().min(1),
  total: z.int().min(0),
  has_more: z.boolean(),
  truncated: z.boolean(),
});

export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;
export type ApiError = z.infer<typeof apiErrorSchema>;
export type ConnectGithubRequest = z.infer<typeof connectGithubRequestSchema>;
export type GithubConnection = z.infer<typeof githubConnectionSchema>;
export type ConnectGithubResponse = z.infer<typeof connectGithubResponseSchema>;
export type RepositoryListQuery = z.infer<typeof repositoryListQuerySchema>;
export type Repository = z.infer<typeof repositorySchema>;
export type ConnectionErrorCode = z.infer<typeof connectionErrorCodeSchema>;
export type ConnectionStatus = z.infer<typeof connectionStatusSchema>;
export type RepositoryListResponse = z.infer<typeof repositoryListResponseSchema>;
