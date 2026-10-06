import { edgeEnvSchema, edgeSupabaseEnvSchema } from "@stackprep/shared";
import { createSupabaseAuthenticator } from "../_shared/auth.ts";
import { readEnv } from "../_shared/env.ts";
import { initSentry, withSentry } from "../_shared/sentry.ts";
import { createMeHandler, getProfileWithRls } from "./handler.ts";

initSentry("me");
const env = readEnv("me function", edgeEnvSchema.extend(edgeSupabaseEnvSchema.shape));

Deno.serve(withSentry(
  createMeHandler({
    webOrigin: env.WEB_ORIGIN,
    authenticate: createSupabaseAuthenticator(env),
    getProfile: getProfileWithRls,
  }),
  { webOrigin: env.WEB_ORIGIN },
));
