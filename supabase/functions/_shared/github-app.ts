import { MAX_REPOS_PER_INSTALLATION } from "@stackprep/shared";
import { z } from "zod";

const API_BASE = "https://api.github.com";
const OAUTH_TOKEN_URL = "https://github.com/login/oauth/access_token";
const API_VERSION = "2022-11-28";
const REQUEST_TIMEOUT_MS = 10_000;
const TOKEN_REFRESH_BUFFER_MS = 5 * 60_000;
const PER_PAGE = 100;
const MAX_PAGES = MAX_REPOS_PER_INSTALLATION / PER_PAGE;

// Errors -----------------------------------------------------------------------
// Messages are fixed strings: GitHub response bodies never end up in errors or logs.

export interface GithubErrorDetails {
  status?: number;
  requestId?: string;
}

export class GithubError extends Error {
  readonly status?: number;
  readonly requestId?: string;

  constructor(message: string, details: GithubErrorDetails = {}) {
    super(message);
    this.name = new.target.name;
    this.status = details.status;
    this.requestId = details.requestId;
  }
}

export class GithubOAuthCodeError extends GithubError {
  constructor(details?: GithubErrorDetails) {
    super("GitHub rejected the OAuth code", details);
  }
}

export class GithubRateLimitedError extends GithubError {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number, details?: GithubErrorDetails) {
    super("GitHub rate limit exceeded", details);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class GithubForbiddenError extends GithubError {
  constructor(details?: GithubErrorDetails) {
    super("GitHub denied the request", details);
  }
}

export class GithubNotFoundError extends GithubError {
  constructor(details?: GithubErrorDetails) {
    super("GitHub resource not found", details);
  }
}

export class GithubUnavailableError extends GithubError {
  constructor(details?: GithubErrorDetails) {
    super("GitHub is unavailable", details);
  }
}

export class GithubUnexpectedResponseError extends GithubError {
  constructor(details?: GithubErrorDetails) {
    super("Unexpected response from GitHub", details);
  }
}

// Response schemas -------------------------------------------------------------

const oauthTokenResponseSchema = z.union([
  z.object({ error: z.string(), error_description: z.string().optional() }),
  z.object({
    access_token: z.string().min(1),
    token_type: z.string().refine((type) => type.toLowerCase() === "bearer"),
  }),
]);

const githubUserSchema = z.object({ id: z.int().min(1), login: z.string().min(1) });

const userInstallationsSchema = z.object({
  total_count: z.int().min(0),
  installations: z.array(z.object({ id: z.int().min(1), app_id: z.int().min(1) })),
});

const installationSchema = z.object({
  id: z.int().min(1),
  app_id: z.int().min(1),
  account: z
    .object({ id: z.int().min(1), login: z.string().min(1).optional(), type: z.string().optional() })
    .nullable(),
  repository_selection: z.enum(["all", "selected"]),
  permissions: z.record(z.string(), z.string()),
  suspended_at: z.iso.datetime({ offset: true }).nullable(),
});

const installationTokenSchema = z.object({
  token: z.string().min(1),
  expires_at: z.iso.datetime({ offset: true }),
});

const githubRepoSchema = z.object({
  id: z.int().min(1),
  name: z.string().min(1),
  full_name: z.string().min(1),
  private: z.boolean(),
  default_branch: z.string().min(1),
  html_url: z.url({ protocol: /^https$/ }),
  owner: z.object({ login: z.string().min(1) }),
});

const installationReposSchema = z.object({
  total_count: z.int().min(0),
  repositories: z.array(githubRepoSchema),
});

export type GithubInstallation = z.infer<typeof installationSchema>;
export type GithubRepo = z.infer<typeof githubRepoSchema>;

// Client -----------------------------------------------------------------------

export interface GithubAppOptions {
  appId: string;
  clientId: string;
  clientSecret: string;
  /** PKCS#8 PEM; literal `\n` sequences (as stored in env files) are unescaped. */
  privateKeyPem: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** Called when best-effort revocation of a user token fails. Never receives the token. */
  onRevokeFailure?: (err: GithubError) => void;
}

export interface UserInstallationCheck {
  githubUserId: number;
  githubLogin: string;
  hasInstallation: boolean;
}

export interface InstallationRepositories {
  repositories: GithubRepo[];
  truncated: boolean;
}

export interface GithubApp {
  verifyUserInstallation(code: string, installationId: number): Promise<UserInstallationCheck>;
  getInstallation(installationId: number): Promise<GithubInstallation>;
  listAllInstallationRepositories(installationId: number): Promise<InstallationRepositories>;
  /** Test-only access to internals. */
  _internal: {
    getInstallationToken(installationId: number): Promise<string>;
    createAppJwt(): Promise<string>;
  };
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

export function retryAfterSeconds(headers: Headers, nowMs: number): number {
  const retryAfter = headers.get("retry-after")?.trim();
  const reset = headers.get("x-ratelimit-reset")?.trim();
  let seconds = 60;
  if (retryAfter && /^\d+$/.test(retryAfter)) {
    seconds = Number(retryAfter);
  } else if (reset && /^\d+$/.test(reset)) {
    seconds = Math.ceil(Number(reset) - nowMs / 1000);
  }
  return Math.min(3600, Math.max(1, seconds));
}

/** Maps a non-2xx GitHub response to a typed error. */
export function classifyResponse(res: Response, nowMs: number): GithubError {
  const details = { status: res.status, requestId: res.headers.get("x-github-request-id") ?? undefined };
  const rateLimited = res.status === 429 ||
    (res.status === 403 &&
      (res.headers.get("x-ratelimit-remaining")?.trim() === "0" || res.headers.has("retry-after")));
  if (rateLimited) {
    return new GithubRateLimitedError(retryAfterSeconds(res.headers, nowMs), details);
  }
  if (res.status === 403) {
    return new GithubForbiddenError(details);
  }
  if (res.status === 404) {
    return new GithubNotFoundError(details);
  }
  if (res.status >= 500 && res.status <= 599) {
    return new GithubUnavailableError(details);
  }
  return new GithubUnexpectedResponseError(details);
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function pemToDer(pem: string): Uint8Array<ArrayBuffer> {
  const body = pem
    .replaceAll("\\n", "\n")
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s+/g, "");
  return Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
}

export function createGithubApp({
  appId,
  clientId,
  clientSecret,
  privateKeyPem,
  fetch: fetchFn = globalThis.fetch,
  now = Date.now,
  onRevokeFailure = () => {},
}: GithubAppOptions): GithubApp {
  const appIdNumber = Number(appId);
  const tokens = new Map<number, CachedToken>();
  const inflight = new Map<number, Promise<CachedToken>>();
  let signingKey: Promise<CryptoKey> | undefined;

  function importSigningKey(): Promise<CryptoKey> {
    signingKey ??= crypto.subtle
      .importKey("pkcs8", pemToDer(privateKeyPem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"])
      .catch((err) => {
        signingKey = undefined;
        throw err;
      });
    return signingKey;
  }

  async function createAppJwt(): Promise<string> {
    const iat = Math.floor(now() / 1000) - 60;
    const encoder = new TextEncoder();
    const header = base64Url(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
    const payload = base64Url(encoder.encode(JSON.stringify({ iat, exp: iat + 600, iss: appId })));
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      await importSigningKey(),
      encoder.encode(`${header}.${payload}`),
    );
    return `${header}.${payload}.${base64Url(new Uint8Array(signature))}`;
  }

  async function send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetchFn(url, {
        ...init,
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": API_VERSION,
          "User-Agent": "stackprep",
          ...init.headers,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new GithubUnavailableError();
    }
  }

  async function requestJson<T>(url: string, init: RequestInit, schema: z.ZodType<T>): Promise<T> {
    const res = await send(url, init);
    if (!res.ok) {
      await res.body?.cancel();
      throw classifyResponse(res, now());
    }
    const details = { status: res.status, requestId: res.headers.get("x-github-request-id") ?? undefined };
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new GithubUnexpectedResponseError(details);
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new GithubUnexpectedResponseError(details);
    }
    return parsed.data;
  }

  async function exchangeCode(code: string): Promise<string> {
    const body = await requestJson(
      OAUTH_TOKEN_URL,
      {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code }).toString(),
      },
      oauthTokenResponseSchema,
    );
    if ("error" in body) {
      throw body.error === "bad_verification_code" ? new GithubOAuthCodeError() : new GithubUnexpectedResponseError();
    }
    return body.access_token;
  }

  async function revokeUserToken(userToken: string): Promise<void> {
    try {
      const res = await send(`${API_BASE}/applications/${encodeURIComponent(clientId)}/token`, {
        method: "DELETE",
        headers: {
          Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ access_token: userToken }),
      });
      await res.body?.cancel();
      if (!res.ok) {
        onRevokeFailure(classifyResponse(res, now()));
      }
    } catch (err) {
      onRevokeFailure(err instanceof GithubError ? err : new GithubUnexpectedResponseError());
    }
  }

  async function userHasInstallation(userToken: string, installationId: number): Promise<boolean> {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { installations } = await requestJson(
        `${API_BASE}/user/installations?per_page=${PER_PAGE}&page=${page}`,
        { headers: { Authorization: `Bearer ${userToken}` } },
        userInstallationsSchema,
      );
      if (installations.some((i) => i.id === installationId && i.app_id === appIdNumber)) {
        return true;
      }
      if (installations.length < PER_PAGE) {
        return false;
      }
    }
    return false;
  }

  async function verifyUserInstallation(code: string, installationId: number): Promise<UserInstallationCheck> {
    const userToken = await exchangeCode(code);
    try {
      const user = await requestJson(
        `${API_BASE}/user`,
        { headers: { Authorization: `Bearer ${userToken}` } },
        githubUserSchema,
      );
      const hasInstallation = await userHasInstallation(userToken, installationId);
      return { githubUserId: user.id, githubLogin: user.login, hasInstallation };
    } finally {
      await revokeUserToken(userToken);
    }
  }

  async function getInstallation(installationId: number): Promise<GithubInstallation> {
    return requestJson(
      `${API_BASE}/app/installations/${installationId}`,
      { headers: { Authorization: `Bearer ${await createAppJwt()}` } },
      installationSchema,
    );
  }

  async function withTokenEviction<T>(installationId: number, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (err instanceof GithubError && err.status === 401) {
        tokens.delete(installationId);
      }
      throw err;
    }
  }

  async function mintInstallationToken(installationId: number): Promise<CachedToken> {
    const body = await withTokenEviction(installationId, async () =>
      requestJson(
        `${API_BASE}/app/installations/${installationId}/access_tokens`,
        { method: "POST", headers: { Authorization: `Bearer ${await createAppJwt()}` } },
        installationTokenSchema,
      ));
    const cached = { token: body.token, expiresAt: Date.parse(body.expires_at) };
    tokens.set(installationId, cached);
    return cached;
  }

  async function getInstallationToken(installationId: number): Promise<string> {
    const cached = tokens.get(installationId);
    if (cached && cached.expiresAt - now() > TOKEN_REFRESH_BUFFER_MS) {
      return cached.token;
    }
    let pending = inflight.get(installationId);
    if (!pending) {
      pending = mintInstallationToken(installationId).finally(() => inflight.delete(installationId));
      inflight.set(installationId, pending);
    }
    return (await pending).token;
  }

  async function listRepositoriesPage(installationId: number, token: string, page: number) {
    try {
      return await withTokenEviction(installationId, () =>
        requestJson(
          `${API_BASE}/installation/repositories?per_page=${PER_PAGE}&page=${page}`,
          { headers: { Authorization: `Bearer ${token}` } },
          installationReposSchema,
        ));
    } catch (err) {
      if (err instanceof GithubForbiddenError || err instanceof GithubNotFoundError) {
        throw new GithubUnexpectedResponseError({ status: err.status, requestId: err.requestId });
      }
      throw err;
    }
  }

  /**
   * GithubForbiddenError / GithubNotFoundError from this call always come from minting the
   * installation token (suspended / uninstalled); 403/404 on the listing itself are unexpected.
   */
  async function listAllInstallationRepositories(installationId: number): Promise<InstallationRepositories> {
    const token = await getInstallationToken(installationId);
    const repositories: GithubRepo[] = [];
    let totalCount = 0;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const body = await listRepositoriesPage(installationId, token, page);
      totalCount = body.total_count;
      repositories.push(...body.repositories);
      if (body.repositories.length === 0 || repositories.length >= totalCount) {
        break;
      }
    }
    return { repositories, truncated: totalCount > MAX_REPOS_PER_INSTALLATION };
  }

  return {
    verifyUserInstallation,
    getInstallation,
    listAllInstallationRepositories,
    _internal: { getInstallationToken, createAppJwt },
  };
}
