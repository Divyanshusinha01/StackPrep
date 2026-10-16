import {
  type OpenAIKeyStatusResponse,
  openAIKeyStatusResponseSchema,
  type ProfileResponse,
  profileResponseSchema,
  saveOpenAIKeyRequestSchema,
} from "@stackprep/shared";
import { OpenAIKeyUndecryptableError } from "../_shared/ai/credentials.ts";
import type { KeyValidationResult, KeyValidator } from "../_shared/ai/key-validation.ts";
import type { AuthContext, Authenticate } from "../_shared/auth.ts";
import { apiError, logGithubError } from "../_shared/github-errors.ts";
import { type Cors, createCors, json } from "../_shared/http.ts";
import { safetyIdentifier } from "../_shared/realtime/openai-realtime.ts";
import type { OpenAIKeyStore } from "./openai-key-store.ts";

const FN = "me";
const ROUTE = /\/me(\/openai-key(\/validate)?)?\/?$/;
const ATTEMPT_RETRY_AFTER_SECONDS = 600;

export interface MeHandlerOptions {
  webOrigin: string;
  authenticate: Authenticate;
  getProfile(ctx: AuthContext): Promise<ProfileResponse | null>;
  openAIKeys: OpenAIKeyStore;
  validateKey: KeyValidator;
}

export async function getProfileWithRls({ user, supabase }: AuthContext): Promise<ProfileResponse | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select("id, github_login, display_name, avatar_url")
    .eq("id", user.id)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to load profile: ${error.message}`);
  }
  return data;
}

/** The response for a validation that did not succeed; `null` for success. */
function validationFailure(result: KeyValidationResult, cors: Cors): Response | null {
  switch (result.outcome) {
    case "valid":
      return null;
    case "rate_limited":
      return apiError("openai_rate_limited", cors, { "Retry-After": String(result.retryAfterSeconds) });
    case "unavailable":
      return apiError("openai_unavailable", cors);
    case "unusable":
      switch (result.status) {
        case "invalid":
          return apiError("openai_key_invalid", cors);
        case "quota_exhausted":
          return apiError("openai_quota_exhausted", cors);
        case "permission_denied":
          return apiError("openai_key_permission_denied", cors, {}, result.model ? { model: result.model } : {});
      }
  }
}

export function createMeHandler({ webOrigin, authenticate, getProfile, openAIKeys, validateKey }: MeHandlerOptions) {
  const cors = createCors(webOrigin, ["GET", "PUT", "POST", "DELETE"]);

  async function keyStatus(userId: string): Promise<OpenAIKeyStatusResponse> {
    const row = await openAIKeys.getStatus(userId);
    return openAIKeyStatusResponseSchema.parse(row ? { configured: true, ...row } : { configured: false });
  }

  async function getProfileResponse(ctx: AuthContext): Promise<Response> {
    const profile = await getProfile(ctx);
    if (!profile) {
      return apiError("not_found", cors);
    }
    return json(profileResponseSchema.parse(profile), { headers: cors.headers });
  }

  /** Validates before storing, so a failed replacement leaves the previous key in place. */
  async function saveKey(req: Request, userId: string): Promise<Response> {
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return apiError("invalid_request", cors);
    }
    const parsed = saveOpenAIKeyRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return apiError("invalid_request", cors);
    }
    if (!(await openAIKeys.reserveAttempt(userId))) {
      return apiError("rate_limited", cors, { "Retry-After": String(ATTEMPT_RETRY_AFTER_SECONDS) });
    }
    const apiKey = parsed.data.api_key;
    const failure = validationFailure(await validateKey(apiKey, await safetyIdentifier(userId)), cors);
    if (failure) {
      return failure;
    }
    await openAIKeys.save(userId, apiKey);
    return json(await keyStatus(userId), { headers: cors.headers });
  }

  async function revalidateKey(userId: string): Promise<Response> {
    if (!(await openAIKeys.reserveAttempt(userId))) {
      return apiError("rate_limited", cors, { "Retry-After": String(ATTEMPT_RETRY_AFTER_SECONDS) });
    }
    let stored;
    try {
      stored = await openAIKeys.load(userId);
    } catch (err) {
      if (err instanceof OpenAIKeyUndecryptableError) {
        logGithubError(FN, err, { event: "openai_key_undecryptable", code: "openai_key_invalid" });
        return apiError("openai_key_invalid", cors);
      }
      throw err;
    }
    if (!stored) {
      return apiError("openai_key_required", cors);
    }
    const result = await validateKey(stored.apiKey, await safetyIdentifier(userId));
    if (result.outcome === "valid") {
      await openAIKeys.markStatus(userId, stored.credentialId, "valid", null);
    } else if (result.outcome === "unusable") {
      await openAIKeys.markStatus(userId, stored.credentialId, result.status, result.code);
    }
    return validationFailure(result, cors) ?? json(await keyStatus(userId), { headers: cors.headers });
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
    const keyRoute = match[1] !== undefined;
    const validateRoute = match[2] !== undefined;
    const allowed = validateRoute ? "POST" : keyRoute ? "GET, PUT, DELETE" : "GET";
    if (!allowed.split(", ").includes(req.method)) {
      return apiError("method_not_allowed", cors, { Allow: `${allowed}, OPTIONS` });
    }

    const ctx = await authenticate(req);
    if (!ctx) {
      return apiError("unauthorized", cors);
    }
    const userId = ctx.user.id;

    try {
      if (!keyRoute) {
        return await getProfileResponse(ctx);
      }
      if (validateRoute) {
        return await revalidateKey(userId);
      }
      switch (req.method) {
        case "PUT":
          return await saveKey(req, userId);
        case "DELETE":
          await openAIKeys.delete(userId);
          return new Response(null, { status: 204, headers: { ...cors.headers, "Cache-Control": "no-store" } });
        default:
          return json(await keyStatus(userId), { headers: cors.headers });
      }
    } catch (err) {
      logGithubError(FN, err, { code: "internal_error" });
      return apiError("internal_error", cors);
    }
  };
}
