import type { ApiError, ApiErrorCode, ConnectionErrorCode } from "@stackprep/shared";
import { GithubError, GithubOAuthCodeError, GithubRateLimitedError, GithubUnavailableError } from "./github-app.ts";
import { type Cors, json } from "./http.ts";
import { reportUnexpected } from "./sentry.ts";

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
  interview_not_found: "Interview not found",
  interview_preparing: "The interview is still being prepared",
  interview_planning_failed: "The interview could not be prepared",
  interview_not_active: "The interview has ended",
  realtime_unavailable: "The voice service is unavailable",
  event_conflict: "This event id was already used for a different event",
  interview_not_completed: "The interview has not been completed",
  report_not_retryable: "The report can only be retried after it fails",
  interview_interrupted: "The interview is paused by a technical interruption",
  interview_paused: "The interview is paused; resume it first",
  pause_limit_reached: "This interview has already been paused the maximum number of times",
  pause_expired: "The pause lasted too long and the interview was ended",
  voice_not_connected: "No voice session is connected",
  invalid_cursor: "The event cursor is invalid",
  rate_limited: "Too many requests",
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
  interview_not_found: 404,
  interview_preparing: 409,
  interview_planning_failed: 409,
  interview_not_active: 409,
  realtime_unavailable: 502,
  event_conflict: 409,
  interview_not_completed: 409,
  report_not_retryable: 409,
  interview_interrupted: 409,
  interview_paused: 409,
  pause_limit_reached: 409,
  pause_expired: 409,
  voice_not_connected: 409,
  invalid_cursor: 400,
  rate_limited: 429,
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

/**
 * One JSON line with an allow-listed set of keys; never headers, bodies, tokens, or messages.
 * Internal failures are also reported to Sentry with the same keys.
 */
export function logGithubError(fn: string, err: unknown, ctx: LogContext = {}): void {
  const event = ctx.event ?? "github_request_failed";
  const code = ctx.code ?? errorCode(err);
  const entry: Record<string, string | number> = { event, fn, code };
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
  reportUnexpected(err, { ...ctx, event, fn, code });
}
