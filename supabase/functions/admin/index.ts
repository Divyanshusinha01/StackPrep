import { adminEnvSchema, edgeEnvSchema, edgeSupabaseEnvSchema } from "@stackprep/shared";
import { createClient } from "@supabase/supabase-js";
import { createSupabaseAuthenticator } from "../_shared/auth.ts";
import { readEnv } from "../_shared/env.ts";
import { initSentry, withSentry } from "../_shared/sentry.ts";
import { createAdminHandler, createAdminMetricsLoader } from "./handler.ts";

initSentry("admin");
const env = readEnv("admin function", edgeEnvSchema.extend(edgeSupabaseEnvSchema.shape).extend(adminEnvSchema.shape));

const serviceClient = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

Deno.serve(withSentry(
  createAdminHandler({
    webOrigin: env.WEB_ORIGIN,
    authenticate: createSupabaseAuthenticator(env),
    adminUserIds: env.ADMIN_USER_IDS,
    loadMetrics: createAdminMetricsLoader(serviceClient),
  }),
  { webOrigin: env.WEB_ORIGIN },
));
