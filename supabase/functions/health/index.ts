import { edgeEnvSchema } from "@stackprep/shared";
import { readEnv } from "../_shared/env.ts";
import { initSentry, withSentry } from "../_shared/sentry.ts";
import { createHealthHandler } from "./handler.ts";

initSentry("health");
const env = readEnv("health function", edgeEnvSchema);

Deno.serve(withSentry(createHealthHandler({ webOrigin: env.WEB_ORIGIN }), { webOrigin: env.WEB_ORIGIN }));
