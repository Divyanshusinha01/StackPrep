import type { ApiError, ApiErrorCode, ConnectionErrorCode } from "@stackprep/shared";
import { GithubError, GithubOAuthCodeError, GithubRateLimitedError, GithubUnavailableError } from "./github-app.ts";
import { type Cors, json } from "./http.ts";

const ERROR_MESSAGES: Record<ApiErrorCode, string> = {
  method_not_allowed: "Method not allowed",
  not_found: "Not found",
  invalid_request: "Invalid request",
  unauthorized: "Unauthorized",
  invalid_oauth_code: "The GitHub authorization code is invalid or expired",
  github_account_mismatch: "The GitHub account does not match the signed-in account",
  installation_not_accessible: "The GitHub App installation is not accessible",
  unsupported_installation_account: "The GitHub App installation account type is not supported",
  installation_suspended: "The GitHub App installation is suspended",
  connection_not_found: "GitHub connection not found",
  repository_not_accessible: "The repository is not accessible through this GitHub connection",
  workspace_not_found: "Workspace not found",
  analysis_not_retryable: "Repository analysis can only be retried after it fails",
  workspace_not_ready: "The workspace is not ready for interviews yet",
  interview_limit_reached: "You have reached the limit of 5 interviews in 24 hours",
  github_rate_limited: "GitHub rate limit exceeded",
  github_unavailable: "GitHub is unavailable",
  github_unexpected_response: "Unexpected response from GitHub",
  internal_error: "Internal error",
};

const ERROR_STATUS: Record<ApiErrorCode, number> = {
  method_not_allowed: 405,
  not_found: 404,
  invalid_request: 400,
  unauthorized: 401,
  invalid_oauth_code: 400,
  github_account_mismatch: 403,
  installation_not_accessible: 403,
  unsupported_installation_account: 422,
  installation_suspended: 409,
  connection_not_found: 404,
  repository_not_accessible: 403,
  workspace_not_found: 404,
  analysis_not_retryable: 409,
  workspace_not_ready: 409,
  interview_limit_reached: 429,
  github_rate_limited: 503,
  github_unavailable: 502,
  github_unexpected_response: 502,
  internal_error: 500,
};

/** `{ error, code }` response with the status defined for `code`. */
export function apiError(
  code: ApiErrorCode,
  cors: Cors,
  headers: Record<string, string> = {},
  extra: Omit<ApiError, "error" | "code"> = {},
): Response {
  return json(
    { error: ERROR_MESSAGES[code], code, ...extra },
    { status: ERROR_STATUS[code], headers: { ...cors.headers, ...headers } },
  );
}

/** Code for a failed GitHub call that has no context-specific meaning. */
export function githubErrorCode(err: GithubError): ConnectionErrorCode {
  if (err instanceof GithubRateLimitedError) {
    return "github_rate_limited";
  }
  if (err instanceof GithubUnavailableError) {
    return "github_unavailable";
  }
  return "github_unexpected_response";
}

export function errorCode(err: unknown): ApiErrorCode {
  if (err instanceof GithubOAuthCodeError) {
    return "invalid_oauth_code";
  }
  return err instanceof GithubError ? githubErrorCode(err) : "internal_error";
}

export function githubErrorResponse(err: unknown, cors: Cors): Response {
  const headers: Record<string, string> = err instanceof GithubRateLimitedError
    ? { "Retry-After": String(err.retryAfterSeconds) }
    : {};
  return apiError(errorCode(err), cors, headers);
}

export interface LogContext {
  event?: string;
  code?: ApiErrorCode;
  installation_id?: number;
  connection_id?: string;
  workspace_id?: string;
  interview_id?: string;
}

/** One JSON line with an allow-listed set of keys; never headers, bodies, tokens, or messages. */
export function logGithubError(fn: string, err: unknown, ctx: LogContext = {}): void {
  const entry: Record<string, string | number> = {
    event: ctx.event ?? "github_request_failed",
    fn,
    code: ctx.code ?? errorCode(err),
  };
  if (err instanceof GithubError) {
    if (err.status !== undefined) {
      entry.github_status = err.status;
    }
    if (err.requestId !== undefined) {
      entry.github_request_id = err.requestId;
    }
  }
  if (ctx.installation_id !== undefined) {
    entry.installation_id = ctx.installation_id;
  }
  if (ctx.connection_id !== undefined) {
    entry.connection_id = ctx.connection_id;
  }
  if (ctx.workspace_id !== undefined) {
    entry.workspace_id = ctx.workspace_id;
  }
  if (ctx.interview_id !== undefined) {
    entry.interview_id = ctx.interview_id;
  }
  console.error(JSON.stringify(entry));
}
