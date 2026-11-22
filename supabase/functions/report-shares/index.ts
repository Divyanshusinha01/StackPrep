import { edgeEnvSchema, edgeSupabaseEnvSchema } from "@stackprep/shared";
import { createClient } from "@supabase/supabase-js";
import { createSupabaseAuthenticator } from "../_shared/auth.ts";
import { readEnv } from "../_shared/env.ts";
import { initSentry, withSentry } from "../_shared/sentry.ts";
import { createReportShareReader, createReportSharesHandler, createReportShareStore } from "./handler.ts";

initSentry("report-shares");
const env = readEnv(
  "report-shares function",
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
  createReportSharesHandler({
    webOrigin: env.WEB_ORIGIN,
    authenticate: createSupabaseAuthenticator(env),
    reader: createReportShareReader,
    store: createReportShareStore(serviceClient),
  }),
  { webOrigin: env.WEB_ORIGIN },
));
