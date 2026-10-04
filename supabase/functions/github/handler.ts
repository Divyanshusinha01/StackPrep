import { connectGithubRequestSchema, connectGithubResponseSchema } from "@stackprep/shared";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Authenticate } from "../_shared/auth.ts";
import { type GithubApp, type GithubInstallation, GithubNotFoundError } from "../_shared/github-app.ts";
import { apiError, githubErrorResponse, logGithubError } from "../_shared/github-errors.ts";
import { createCors, json } from "../_shared/http.ts";

const FN = "github";

export interface ConnectionUpsert {
  github_user_id: number;
  installation_id: number;
  account_login: string;
  account_type: "User" | "Organization";
  repository_selection: "all" | "selected";
  permissions: Record<string, string>;
}

export interface StoredConnection {
  id: string;
  account_login: string;
  account_type: string | null;
  repository_selection: string | null;
  suspended_at: string | null;
}

export type UpsertConnection = (userId: string, data: ConnectionUpsert) => Promise<StoredConnection>;

export interface GithubConnectHandlerOptions {
  webOrigin: string;
  authenticate: Authenticate;
  github: Pick<GithubApp, "verifyUserInstallation" | "getInstallation">;
  appId: string;
  upsertConnection: UpsertConnection;
}

/** Writes with the service-role client; `user_id` must come from the verified JWT. */
export function createUpsertConnection(serviceClient: SupabaseClient): UpsertConnection {
  return async (userId, data) => {
    const { data: row, error } = await serviceClient
      .from("github_connections")
      .upsert({ user_id: userId, ...data, suspended_at: null }, { onConflict: "user_id,installation_id" })
      .select("id, account_login, account_type, repository_selection, suspended_at")
      .single();
    if (error) {
      throw new Error(`Failed to upsert GitHub connection: ${error.message}`);
    }
    return row;
  };
}

function isSupportedAccount(
  account: GithubInstallation["account"],
): account is { id: number; login: string; type: "User" | "Organization" } {
  return !!account?.login && (account.type === "User" || account.type === "Organization");
}

export function createGithubConnectHandler({
  webOrigin,
  authenticate,
  github,
  appId,
  upsertConnection,
}: GithubConnectHandlerOptions) {
  const cors = createCors(webOrigin, ["POST"]);
  const appIdNumber = Number(appId);

  async function connect(req: Request): Promise<Response> {
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
    const parsed = connectGithubRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return apiError("invalid_request", cors);
    }
    const { code, installation_id: installationId } = parsed.data;

    const expectedGithubId = ctx.user.identities?.find((identity) => identity.provider === "github")?.id;
    if (!expectedGithubId) {
      return apiError("github_account_mismatch", cors);
    }

    let check;
    try {
      check = await github.verifyUserInstallation(code, installationId);
    } catch (err) {
      logGithubError(FN, err, { installation_id: installationId });
      return githubErrorResponse(err, cors);
    }
    if (String(check.githubUserId) !== expectedGithubId) {
      return apiError("github_account_mismatch", cors);
    }
    if (!check.hasInstallation) {
      return apiError("installation_not_accessible", cors);
    }

    let installation: GithubInstallation;
    try {
      installation = await github.getInstallation(installationId);
    } catch (err) {
      if (err instanceof GithubNotFoundError) {
        logGithubError(FN, err, { code: "installation_not_accessible", installation_id: installationId });
        return apiError("installation_not_accessible", cors);
      }
      logGithubError(FN, err, { installation_id: installationId });
      return githubErrorResponse(err, cors);
    }
    if (installation.app_id !== appIdNumber || installation.id !== installationId) {
      return apiError("installation_not_accessible", cors);
    }
    const account = installation.account;
    if (!isSupportedAccount(account)) {
      return apiError("unsupported_installation_account", cors);
    }
    if (installation.suspended_at !== null) {
      return apiError("installation_suspended", cors);
    }

    let row: StoredConnection;
    try {
      row = await upsertConnection(ctx.user.id, {
        github_user_id: check.githubUserId,
        installation_id: installationId,
        account_login: account.login,
        account_type: account.type,
        repository_selection: installation.repository_selection,
        permissions: installation.permissions,
      });
    } catch (err) {
      logGithubError(FN, err, { code: "internal_error", installation_id: installationId });
      return apiError("internal_error", cors);
    }

    const body = connectGithubResponseSchema.parse({
      connection: {
        id: row.id,
        account_login: row.account_login,
        account_type: row.account_type,
        repository_selection: row.repository_selection,
        suspended: row.suspended_at !== null,
      },
    });
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

    if (!new URL(req.url).pathname.endsWith("/github/connect")) {
      return apiError("not_found", cors);
    }

    if (req.method !== "POST") {
      return apiError("method_not_allowed", cors, { Allow: "POST, OPTIONS" });
    }

    try {
      return await connect(req);
    } catch (err) {
      logGithubError(FN, err, { code: "internal_error" });
      return apiError("internal_error", cors);
    }
  };
}
