import { type HealthResponse, healthResponseSchema } from "@stackprep/shared";

export interface HealthHandlerOptions {
  webOrigin: string;
}

export function createHealthHandler({ webOrigin }: HealthHandlerOptions) {
  const allowedOrigin = new URL(webOrigin).origin;
  const corsHeaders = {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    Vary: "Origin",
  };

  return (req: Request): Response => {
    const origin = req.headers.get("Origin");
    if (origin !== null && origin !== allowedOrigin) {
      return Response.json({ error: "Origin not allowed" }, { status: 403, headers: { Vary: "Origin" } });
    }

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (req.method !== "GET") {
      return Response.json(
        { error: "Method not allowed" },
        { status: 405, headers: { ...corsHeaders, Allow: "GET, OPTIONS" } },
      );
    }

    const body: HealthResponse = healthResponseSchema.parse({
      status: "ok",
      service: "api",
      timestamp: new Date().toISOString(),
    });
    return Response.json(body, { headers: { ...corsHeaders, "Cache-Control": "no-store" } });
  };
}
