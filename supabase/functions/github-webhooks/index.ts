import { edgeSupabaseEnvSchema, githubAppEnvSchema, inngestEnvSchema } from "@stackprep/shared";
import { createClient } from "@supabase/supabase-js";
import { readEnv } from "../_shared/env.ts";
import { createInngestClient } from "../_shared/inngest.ts";
import { createInngestJobQueue } from "../_shared/jobs.ts";
import { initSentry, withSentry } from "../_shared/sentry.ts";
import { createGithubWebhooksHandler, createMarkPushReceived } from "./handler.ts";

initSentry("github-webhooks");
const env = readEnv(
  "github-webhooks function",
  edgeSupabaseEnvSchema
    .extend(githubAppEnvSchema.pick({ GITHUB_APP_WEBHOOK_SECRET: true }).shape)
    .extend(inngestEnvSchema.shape),
);

const serviceClient = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

// Called by GitHub, not browsers: requests are authenticated by the webhook signature.
Deno.serve(withSentry(
  createGithubWebhooksHandler({
    webhookSecret: env.GITHUB_APP_WEBHOOK_SECRET,
    markPushReceived: createMarkPushReceived(serviceClient),
    jobs: createInngestJobQueue(createInngestClient(env)),
  }),
));
