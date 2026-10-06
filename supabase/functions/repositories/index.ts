import { edgeEnvSchema, edgeSupabaseEnvSchema, githubAppEnvSchema } from "@stackprep/shared";
import { createClient } from "@supabase/supabase-js";
import { createSupabaseAuthenticator } from "../_shared/auth.ts";
import { readEnv } from "../_shared/env.ts";
import { createGithubApp } from "../_shared/github-app.ts";
import { initSentry, withSentry } from "../_shared/sentry.ts";
import { createConnectionStateWriters, createRepositoriesHandler } from "./handler.ts";

initSentry("repositories");
const env = readEnv(
  "repositories function",
  edgeEnvSchema.extend(edgeSupabaseEnvSchema.shape).extend(githubAppEnvSchema.shape),
);

const serviceClient = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

const github = createGithubApp({
  appId: env.GITHUB_APP_ID,
  clientId: env.GITHUB_APP_CLIENT_ID,
  clientSecret: env.GITHUB_APP_CLIENT_SECRET,
  privateKeyPem: env.GITHUB_APP_PRIVATE_KEY,
});

Deno.serve(withSentry(
  createRepositoriesHandler({
    webOrigin: env.WEB_ORIGIN,
    authenticate: createSupabaseAuthenticator(env),
    github,
    ...createConnectionStateWriters(serviceClient),
  }),
  { webOrigin: env.WEB_ORIGIN },
));
