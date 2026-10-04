import { type ApiErrorCode, apiErrorCodeSchema, parseEnv, webGithubAppEnvSchema } from "@stackprep/shared";

/** Parsed on call so pages that never render the install link do not require the slug. */
export function githubInstallUrl(): string {
  const { NEXT_PUBLIC_GITHUB_APP_SLUG: slug } = parseEnv("web GitHub App", webGithubAppEnvSchema, {
    NEXT_PUBLIC_GITHUB_APP_SLUG: process.env.NEXT_PUBLIC_GITHUB_APP_SLUG,
  });
  return `https://github.com/apps/${encodeURIComponent(slug)}/installations/new`;
}

/** Errors the setup callback can redirect with: backend codes plus ones detected before calling it. */
export type ConnectError = ApiErrorCode | "missing_code" | "install_requested";

export function parseConnectError(value: unknown): ConnectError | null {
  if (value === "missing_code" || value === "install_requested") {
    return value;
  }
  const parsed = apiErrorCodeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

const CONNECT_ERROR_MESSAGES: Partial<Record<ConnectError, string>> = {
  missing_code:
    "GitHub did not return an authorization code. Make sure the StackPrep GitHub App requests user authorization during installation.",
  install_requested:
    "Your installation request was sent to the organization's owners. You can connect it here once they approve it.",
  invalid_request: "The link from GitHub was incomplete or malformed.",
  invalid_oauth_code: "The GitHub authorization has expired or was already used.",
  github_account_mismatch:
    "That installation was authorized by a different GitHub account than the one you signed in with.",
  installation_not_accessible: "Your GitHub account does not have access to that installation.",
  unsupported_installation_account: "StackPrep can only be installed on a personal account or an organization.",
  installation_suspended: "That installation is suspended on GitHub. Unsuspend it in GitHub settings, then try again.",
  github_rate_limited: "GitHub is rate limiting requests right now. Wait a minute, then try again.",
  github_unavailable: "GitHub could not be reached.",
  github_unexpected_response: "GitHub returned an unexpected response.",
};

export function connectErrorMessage(code: ConnectError): string {
  return CONNECT_ERROR_MESSAGES[code] ?? "Connecting GitHub did not complete.";
}
