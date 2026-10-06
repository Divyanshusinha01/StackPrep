import { edgeSupabaseEnvSchema, githubAppEnvSchema, inngestEnvSchema, openAIEnvSchema } from "@stackprep/shared";
import { createClient } from "@supabase/supabase-js";
import { createOpenAIProvider } from "../_shared/ai/openai.ts";
import { readEnv } from "../_shared/env.ts";
import { createGithubApp } from "../_shared/github-app.ts";
import { createInngestClient } from "../_shared/inngest.ts";
import { createInngestJobQueue } from "../_shared/jobs.ts";
import { initSentry, withSentry } from "../_shared/sentry.ts";
import { createDeepAnalysisFunction } from "./deep-analysis.ts";
import { createDeepAnalysisStore } from "./deep-analysis-store.ts";
import { createRepositoryAnalysisFunction } from "./function.ts";
import { createInngestHandler } from "./handler.ts";
import { createInterviewPlanningFunction } from "./planning.ts";
import { createPlanningStore } from "./planning-store.ts";
import { createInterviewReportFunction } from "./report.ts";
import { createReportStore } from "./report-store.ts";
import { createAnalysisStore } from "./store.ts";

initSentry("inngest");
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
const ai = createOpenAIProvider({ apiKey: env.OPENAI_API_KEY });

Deno.serve(withSentry(
  createInngestHandler(inngest, [
    createRepositoryAnalysisFunction(inngest, {
      github,
      store: createAnalysisStore(serviceClient),
      jobs: createInngestJobQueue(inngest),
    }),
    createDeepAnalysisFunction(inngest, {
      ai,
      model: env.OPENAI_PLANNING_MODEL,
      store: createDeepAnalysisStore(serviceClient),
    }),
    createInterviewPlanningFunction(inngest, {
      ai,
      model: env.OPENAI_PLANNING_MODEL,
      store: createPlanningStore(serviceClient),
    }),
    createInterviewReportFunction(inngest, {
      ai,
      model: env.OPENAI_EVALUATION_MODEL,
      store: createReportStore(serviceClient),
    }),
  ]),
));
