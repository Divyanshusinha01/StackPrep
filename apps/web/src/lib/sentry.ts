import type { Breadcrumb, ErrorEvent, init } from "@sentry/nextjs";
import { parseEnv, redactOpenAIKeys, webSentryEnvSchema } from "@stackprep/shared";

type SentryOptions = Parameters<typeof init>[0];

const SENSITIVE_HEADERS = ["authorization", "cookie", "set-cookie", "apikey", "x-client-info"];
const SENSITIVE_HEADER_SET = new Set(SENSITIVE_HEADERS);

const dsnSchema = webSentryEnvSchema.pick({ NEXT_PUBLIC_SENTRY_DSN: true });

/** Drops the query string (OAuth callbacks carry `code` there) and fragment from a URL. */
function stripQuery(url: string): string {
  const end = url.search(/[?#]/);
  return end === -1 ? url : url.slice(0, end);
}

export function scrubEvent<T extends Pick<ErrorEvent, "request" | "contexts">>(event: T): T {
  const nextjs = event.contexts?.nextjs;
  if (typeof nextjs?.request_path === "string") {
    nextjs.request_path = stripQuery(nextjs.request_path);
  }
  const request = event.request;
  if (request) {
    delete request.cookies;
    delete request.data;
    delete request.query_string;
    if (request.url) {
      request.url = stripQuery(request.url);
    }
    if (request.headers) {
      request.headers = Object.fromEntries(
        Object.entries(request.headers).filter(([name]) => !SENSITIVE_HEADER_SET.has(name.toLowerCase())),
      );
    }
  }
  return redactOpenAIKeys(event);
}

export function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb {
  const data = breadcrumb.data;
  if (data) {
    for (const key of ["url", "from", "to"]) {
      if (typeof data[key] === "string") {
        data[key] = stripQuery(data[key]);
      }
    }
  }
  return redactOpenAIKeys(breadcrumb);
}

/** Shared options for every runtime; `null` (Sentry disabled) when the DSN is empty. */
export function sentryOptions(): SentryOptions | null {
  const rawDsn = process.env.NEXT_PUBLIC_SENTRY_DSN?.trim();
  if (!rawDsn) {
    return null;
  }
  const { NEXT_PUBLIC_SENTRY_DSN: dsn } = parseEnv("web Sentry", dsnSchema, { NEXT_PUBLIC_SENTRY_DSN: rawDsn });
  return {
    dsn,
    environment: process.env.NODE_ENV,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: { request: { deny: SENSITIVE_HEADERS }, response: false },
      httpBodies: [],
      urlQueryParams: false,
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      stackFrameVariables: false,
    },
    tracesSampleRate: 0.1,
    beforeSend: scrubEvent,
    beforeSendTransaction: scrubEvent,
    beforeBreadcrumb: scrubBreadcrumb,
  };
}
