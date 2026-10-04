import { Hono } from "hono";
import { cors } from "hono/cors";
import { type HealthResponse, healthResponseSchema } from "@stackprep/shared";

export interface AppOptions {
  webOrigin: string;
}

export function createApp({ webOrigin }: AppOptions) {
  const app = new Hono();

  app.use("*", cors({ origin: new URL(webOrigin).origin }));

  app.get("/health", (c) => {
    const body: HealthResponse = healthResponseSchema.parse({
      status: "ok",
      service: "api",
      timestamp: new Date().toISOString(),
    });
    return c.json(body);
  });

  return app;
}
