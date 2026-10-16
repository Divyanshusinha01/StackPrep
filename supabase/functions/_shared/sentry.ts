import * as Sentry from "@sentry/deno";
import { type ApiErrorCode, edgeSentryEnvSchema, redactOpenAIKeys } from "@stackprep/shared";
import { readEnv } from "./env.ts";
import type { LogContext } from "./github-errors.ts";
import { json } from "./http.ts";

/** The part of the Sentry SDK used here; tests inject a fake. */
export interface SentryReporter {
  captureException(err: unknown, context: { tags: Record<string, string | number> }): unknown;
  flush(timeoutMs: number): Promise<unknown>;
}

const FLUSH_TIMEOUT_MS = 2000;

/** Caught failures with these codes are bugs or broken dependencies; every other code is an expected outcome. */
const UNEXPECTED_CODES: ReadonlySet<ApiErrorCode> = new Set(["internal_error", "github_unexpected_response"]);

const TAG_KEYS = ["event", "fn", "code", "installation_id", "connection_id", "workspace_id", "interview_id"] as const;

let activeReporter: SentryReporter | null = null;

function stripQuery(url: string): string {
  const end = url.search(/[?#]/);
  return end === -1 ? url : url.slice(0, end);
}

/**
 * Keeps only the request method and query-less URL: never headers, cookies, query strings, or bodies.
 * Anything shaped like an OpenAI secret key is redacted from every remaining string.
 */
export function scrubEvent<T extends Sentry.Event>(event: T): T {
  if (event.request) {
    const { method, url } = event.request;
    event.request = {
      ...(method !== undefined ? { method } : {}),
      ...(url !== undefined ? { url: stripQuery(url) } : {}),
    };
  }
  return redactOpenAIKeys(event);
}

/** No-op when SENTRY_DSN is unset, so Sentry stays optional. */
export function initSentry(functionName: string): void {
  if (!Deno.env.get("SENTRY_DSN")?.trim()) {
    return;
  }
  const env = readEnv(`${functionName} Sentry`, edgeSentryEnvSchema);
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT,
    // Requests served by Deno.serve share one scope and the Edge runtime lacks APIs some default
    // integrations need, so only explicit captures (with per-call tags) are sent.
    defaultIntegrations: false,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      stackFrameVariables: false,
    },
    beforeSend: scrubEvent,
  });
  // `initialScope` tags do not reach captures in the Deno SDK, so the tag is added per capture. Sentry
  // reserves `function` (stack frame function), so the key is `edge_function`.
  activeReporter = {
    captureException: (err, { tags }) =>
      Sentry.captureException(err, { tags: { edge_function: functionName, ...tags } }),
    flush: (timeoutMs) => Sentry.flush(timeoutMs),
  };
}

export interface WithSentryOptions {
  /** Adds the CORS origin header to the 500 so the browser can read it; omit for server-to-server functions. */
  webOrigin?: string;
  /** Defaults to the client set up by `initSentry` (none when Sentry is disabled). */
  reporter?: SentryReporter | null;
}

/**
 * Returns the handler's responses unchanged. A thrown error is captured and flushed before the
 * isolate can be torn down, then answered with the standard `internal_error` 500.
 */
export function withSentry<A extends unknown[]>(
  handler: (req: Request, ...rest: A) => Response | Promise<Response>,
  options: WithSentryOptions = {},
): (req: Request, ...rest: A) => Promise<Response> {
  const headers: Record<string, string> = options.webOrigin
    ? { "Access-Control-Allow-Origin": new URL(options.webOrigin).origin, Vary: "Origin" }
    : {};
  return async (req, ...rest) => {
    try {
      return await handler(req, ...rest);
    } catch (err) {
      console.error(err);
      const reporter = options.reporter === undefined ? activeReporter : options.reporter;
      if (reporter) {
        reporter.captureException(err, { tags: { event: "unhandled_error" } });
        await reporter.flush(FLUSH_TIMEOUT_MS);
      }
      return json({ error: "Internal error", code: "internal_error" }, { status: 500, headers });
    }
  };
}

export type ReportContext = LogContext & { fn?: string };

/**
 * Reports a caught failure that is internal rather than an expected outcome. Context is limited
 * to the same allow-listed keys as the JSON logs. Does not flush: the request continues normally.
 */
export function reportUnexpected(
  err: unknown,
  ctx: ReportContext = {},
  reporter: SentryReporter | null = activeReporter,
): void {
  if (!reporter || (ctx.code !== undefined && !UNEXPECTED_CODES.has(ctx.code))) {
    return;
  }
  const tags: Record<string, string | number> = {};
  for (const key of TAG_KEYS) {
    const value = ctx[key];
    if (value !== undefined) {
      tags[key] = value;
    }
  }
  reporter.captureException(err instanceof Error ? err : new Error(ctx.event ?? "unexpected_error"), { tags });
}
