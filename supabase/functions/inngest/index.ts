import { byokEnvSchema, edgeSupabaseEnvSchema, githubAppEnvSchema, inngestEnvSchema, openAIModelEnvSchema } from "@stackprep/shared";
import { createClient } from "@supabase/supabase-js";
import { createOpenAIClients, openAIClientFactories } from "../_shared/ai/clients.ts";
import { loadKeyring } from "../_shared/ai/keyring.ts";
import { createOpenAICredentialResolver, createOpenAICredentialStore } from "../_shared/ai/credentials.ts";
import { readEnv } from "../_shared/env.ts";
import { createGithubApp } from "../_shared/github-app.ts";
import { createInngestClient } from "../_shared/inngest.ts";
import { createInngestJobQueue } from "../_shared/jobs.ts";
import { initSentry, withSentry } from "../_shared/sentry.ts";
import { createCodeIndexFunction } from "./code-index.ts";
import { createCodeIndexStore } from "./code-index-store.ts";
import { createDeepAnalysisFunction } from "./deep-analysis.ts";
import { createDeepAnalysisStore } from "./deep-analysis-store.ts";
import { createRepositoryAnalysisFunction } from "./function.ts";
import { createInngestHandler } from "./handler.ts";
import { createMemoryEmbeddingFunction } from "./memory-embedding.ts";
import { createMemoryEmbeddingStore } from "./memory-embedding-store.ts";
import { createInterviewPlanningFunction } from "./planning.ts";
import { createPlanningStore } from "./planning-store.ts";
import { createPushReconcileFunction } from "./push-reconcile.ts";
import { createPushSyncFunction } from "./push-sync.ts";
import { createPushSyncStore } from "./push-sync-store.ts";
import { createInterviewReportFunction } from "./report.ts";
import { createReportStore } from "./report-store.ts";
import { createAnalysisStore } from "./store.ts";

initSentry("inngest");
const env = readEnv(
  "inngest function",
  edgeSupabaseEnvSchema
    .extend(githubAppEnvSchema.shape)
    .extend(inngestEnvSchema.shape)
    .extend(openAIModelEnvSchema.shape)
    .extend(byokEnvSchema.shape),
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
const keyring = await loadKeyring(env.OPENAI_KEY_ENCRYPTION_KEYS, env.OPENAI_KEY_ENCRYPTION_ACTIVE_VERSION);
const openai = createOpenAIClients(
  createOpenAICredentialResolver(createOpenAICredentialStore(serviceClient), keyring),
  openAIClientFactories(),
);
const jobs = createInngestJobQueue(inngest);
const pushSyncStore = createPushSyncStore(serviceClient);

Deno.serve(withSentry(
  createInngestHandler(inngest, [
    createRepositoryAnalysisFunction(inngest, {
      github,
      store: createAnalysisStore(serviceClient),
      jobs,
    }),
    createPushSyncFunction(inngest, { github, store: pushSyncStore, jobs }),
    createPushReconcileFunction(inngest, { store: pushSyncStore, jobs }),
    createCodeIndexFunction(inngest, {
      github,
      store: createCodeIndexStore(serviceClient),
      jobs,
    }),
    createDeepAnalysisFunction(inngest, {
      openai,
      model: env.OPENAI_PLANNING_MODEL,
      reasoningEffort: env.OPENAI_PLANNING_REASONING_EFFORT,
      store: createDeepAnalysisStore(serviceClient),
      jobs,
    }),
    createMemoryEmbeddingFunction(inngest, {
      openai,
      model: env.OPENAI_EMBEDDING_MODEL,
      store: createMemoryEmbeddingStore(serviceClient),
    }),
    createInterviewPlanningFunction(inngest, {
      openai,
      model: env.OPENAI_PLANNING_MODEL,
      reasoningEffort: env.OPENAI_PLANNING_REASONING_EFFORT,
      store: createPlanningStore(serviceClient),
    }),
    createInterviewReportFunction(inngest, {
      openai,
      model: env.OPENAI_REPORT_MODEL,
      reasoningEffort: env.OPENAI_REPORT_REASONING_EFFORT,
      store: createReportStore(serviceClient),
    }),
  ]),
));
