import { edgeEnvSchema, edgeSupabaseEnvSchema, githubAppEnvSchema, inngestEnvSchema } from "@stackprep/shared";
import { createClient } from "@supabase/supabase-js";
import { createSupabaseAuthenticator } from "../_shared/auth.ts";
import { readEnv } from "../_shared/env.ts";
import { createGithubApp } from "../_shared/github-app.ts";
import { createInngestClient } from "../_shared/inngest.ts";
import { createInngestJobQueue } from "../_shared/jobs.ts";
import { createWorkspaceReader, createWorkspacesHandler, createWorkspaceWriters } from "./handler.ts";

const env = readEnv(
  "workspaces function",
  edgeEnvSchema.extend(edgeSupabaseEnvSchema.shape).extend(githubAppEnvSchema.shape).extend(inngestEnvSchema.shape),
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

Deno.serve(
  createWorkspacesHandler({
    webOrigin: env.WEB_ORIGIN,
    authenticate: createSupabaseAuthenticator(env),
    github,
    reader: createWorkspaceReader,
    writers: createWorkspaceWriters(serviceClient),
    jobs: createInngestJobQueue(createInngestClient(env)),
  }),
);
