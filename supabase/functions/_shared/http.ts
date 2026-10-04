export interface Cors {
  headers: Record<string, string>;
  /** Returns a 403 response if the request carries an Origin other than the web app's. */
  rejectOrigin(req: Request): Response | null;
}

export function createCors(webOrigin: string, methods: string[]): Cors {
  const allowedOrigin = new URL(webOrigin).origin;
  const headers = {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": [...methods, "OPTIONS"].join(", "),
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    Vary: "Origin",
  };

  return {
    headers,
    rejectOrigin(req) {
      const origin = req.headers.get("Origin");
      if (origin !== null && origin !== allowedOrigin) {
        return Response.json({ error: "Origin not allowed" }, { status: 403, headers: { Vary: "Origin" } });
      }
      return null;
    },
  };
}

export function json(body: unknown, init: ResponseInit & { headers?: Record<string, string> } = {}): Response {
  return Response.json(body, { ...init, headers: { "Cache-Control": "no-store", ...init.headers } });
}
