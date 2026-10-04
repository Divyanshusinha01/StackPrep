import { edgeEnvSchema, edgeSupabaseEnvSchema } from "@stackprep/shared";
import { createSupabaseAuthenticator } from "../_shared/auth.ts";
import { readEnv } from "../_shared/env.ts";
import { createMeHandler, getProfileWithRls } from "./handler.ts";

const env = readEnv("me function", edgeEnvSchema.extend(edgeSupabaseEnvSchema.shape));

Deno.serve(
  createMeHandler({
    webOrigin: env.WEB_ORIGIN,
    authenticate: createSupabaseAuthenticator(env),
    getProfile: getProfileWithRls,
  }),
);
