export const PROTECTED_PATH_PREFIXES = ["/workspaces", "/interviews"] as const;

export const DEFAULT_AUTHENTICATED_PATH = "/workspaces";

export function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PATH_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/**
 * Returns `next` only if it is a same-origin relative path, so post-login redirects
 * cannot be used as an open redirect (`//evil.example`, `/\evil.example`, absolute URLs).
 */
export function safeNextPath(next: string | null | undefined, fallback = DEFAULT_AUTHENTICATED_PATH): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.includes("\\")) {
    return fallback;
  }
  try {
    const base = "http://stackprep.invalid";
    const url = new URL(next, base);
    if (url.origin !== base) {
      return fallback;
    }
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}
