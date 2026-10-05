import { edgeSupabaseEnvSchema, githubAppEnvSchema, inngestEnvSchema, openAIEnvSchema } from "@stackprep/shared";
import { createClient } from "@supabase/supabase-js";
import { createOpenAIProvider } from "../_shared/ai/openai.ts";
import { readEnv } from "../_shared/env.ts";
import { createGithubApp } from "../_shared/github-app.ts";
import { createInngestClient } from "../_shared/inngest.ts";
import { createRepositoryAnalysisFunction } from "./function.ts";
import { createInngestHandler } from "./handler.ts";
import { createInterviewPlanningFunction } from "./planning.ts";
import { createPlanningStore } from "./planning-store.ts";
import { createAnalysisStore } from "./store.ts";

const env = readEnv(
  "inngest function",
  edgeSupabaseEnvSchema.extend(githubAppEnvSchema.shape).extend(inngestEnvSchema.shape).extend(openAIEnvSchema.shape),
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

const inngest = createInngestClient(env);

Deno.serve(
  createInngestHandler(inngest, [
    createRepositoryAnalysisFunction(inngest, { github, store: createAnalysisStore(serviceClient) }),
    createInterviewPlanningFunction(inngest, {
      ai: createOpenAIProvider({ apiKey: env.OPENAI_API_KEY }),
      model: env.OPENAI_PLANNING_MODEL,
      store: createPlanningStore(serviceClient),
    }),
  ]),
);
