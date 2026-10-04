import { type HealthResponse, healthResponseSchema } from "@stackprep/shared";
import { createCors, json } from "../_shared/http.ts";

export interface HealthHandlerOptions {
  webOrigin: string;
}

export function createHealthHandler({ webOrigin }: HealthHandlerOptions) {
  const cors = createCors(webOrigin, ["GET"]);

  return (req: Request): Response => {
    const rejected = cors.rejectOrigin(req);
    if (rejected) {
      return rejected;
    }

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors.headers });
    }

    if (req.method !== "GET") {
      return Response.json(
        { error: "Method not allowed" },
        { status: 405, headers: { ...cors.headers, Allow: "GET, OPTIONS" } },
      );
    }

    const body: HealthResponse = healthResponseSchema.parse({
      status: "ok",
      service: "api",
      timestamp: new Date().toISOString(),
    });
    return json(body, { headers: cors.headers });
  };
}
