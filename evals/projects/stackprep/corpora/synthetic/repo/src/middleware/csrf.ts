import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

const HEADER = "x-csrf-token";
const COOKIE = "csrf_token";

function cookieValue(req: IncomingMessage, name: string): string | null {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) {
      return decodeURIComponent(rest.join("="));
    }
  }
  return null;
}

/** Double-submit check: the header must equal the cookie, compared in constant time. */
export function requireCsrfToken(req: IncomingMessage): boolean {
  const header = req.headers[HEADER];
  const cookie = cookieValue(req, COOKIE);
  if (typeof header !== "string" || !cookie) {
    return false;
  }
  const a = Buffer.from(header);
  const b = Buffer.from(cookie);
  return a.length === b.length && timingSafeEqual(a, b);
}
