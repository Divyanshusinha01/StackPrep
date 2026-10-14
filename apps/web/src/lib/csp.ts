/**
 * Content-Security-Policy builders. Imported by next.config.ts, so only relative imports here.
 *
 * `script-src` keeps 'unsafe-inline' because Next.js inlines its bootstrap and RSC payload scripts;
 * nonces would force every page to render dynamically, including the CDN-cached landing page.
 */

/** Always enforced. form-action is omitted: Chrome enforces it on redirects, which would block the GitHub OAuth sign-in redirect. */
export const ENFORCED_CSP = "frame-ancestors 'none'; base-uri 'self'; object-src 'none'";

function origin(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Sentry's CSP report endpoint for a DSN (`https://KEY@HOST/PROJECT`), or null when unset or malformed. */
export function sentryReportUri(dsn: string | undefined): string | null {
  if (!dsn) return null;
  try {
    const url = new URL(dsn);
    const project = url.pathname.replace(/^\/+/, "");
    if (!url.username || !project) return null;
    return `${url.origin}/api/${project}/security/?sentry_key=${url.username}`;
  } catch {
    return null;
  }
}

export function buildFullCsp({
  supabaseUrl,
  sentryDsn,
  dev,
}: {
  supabaseUrl: string | undefined;
  sentryDsn: string | undefined;
  dev: boolean;
}): string {
  const supabase = origin(supabaseUrl);
  const sentry = origin(sentryDsn);
  const connect = ["'self'", "https://api.openai.com"];
  if (supabase) connect.push(supabase, supabase.replace(/^http/, "ws"));
  if (sentry) connect.push(sentry);
  if (dev) connect.push("ws:");

  const directives: [string, string[]][] = [
    ["default-src", ["'self'"]],
    ["script-src", ["'self'", "'unsafe-inline'", ...(dev ? ["'unsafe-eval'"] : [])]],
    ["style-src", ["'self'", "'unsafe-inline'"]],
    ["img-src", ["'self'", "data:", "blob:"]],
    ["font-src", ["'self'", "data:"]],
    ["media-src", ["'self'", "blob:", "data:"]],
    ["worker-src", ["'self'", "blob:"]],
    ["connect-src", connect],
    ["frame-ancestors", ["'none'"]],
    ["base-uri", ["'self'"]],
    ["object-src", ["'none'"]],
  ];
  const report = sentryReportUri(sentryDsn);
  if (report) directives.push(["report-uri", [report]]);
  return directives.map(([name, values]) => `${name} ${values.join(" ")}`).join("; ");
}
