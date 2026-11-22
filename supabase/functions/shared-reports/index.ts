import { edgeEnvSchema, edgeSupabaseEnvSchema } from "@stackprep/shared";
import { createClient } from "@supabase/supabase-js";
import { readEnv } from "../_shared/env.ts";
import { initSentry, withSentry } from "../_shared/sentry.ts";
import { createSharedReportsHandler, createSharedReportStore } from "./handler.ts";

initSentry("shared-reports");
const env = readEnv(
  "shared-reports function",
  edgeEnvSchema.extend(edgeSupabaseEnvSchema.shape),
);

const serviceClient = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  },
);

Deno.serve(withSentry(
  createSharedReportsHandler({
    webOrigin: env.WEB_ORIGIN,
    store: createSharedReportStore(serviceClient),
  }),
  { webOrigin: env.WEB_ORIGIN },
));
