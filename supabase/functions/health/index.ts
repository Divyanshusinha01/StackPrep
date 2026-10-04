import { edgeEnvSchema, parseEnv } from "@stackprep/shared";
import { createHealthHandler } from "./handler.ts";

const env = parseEnv("health function", edgeEnvSchema, {
  WEB_ORIGIN: Deno.env.get("WEB_ORIGIN"),
});

Deno.serve(createHealthHandler({ webOrigin: env.WEB_ORIGIN }));
