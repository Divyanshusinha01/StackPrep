import { edgeEnvSchema } from "@stackprep/shared";
import { readEnv } from "../_shared/env.ts";
import { createHealthHandler } from "./handler.ts";

const env = readEnv("health function", edgeEnvSchema);

Deno.serve(createHealthHandler({ webOrigin: env.WEB_ORIGIN }));
