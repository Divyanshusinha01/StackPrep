import { edgeEnvSchema, edgeSupabaseEnvSchema, githubAppEnvSchema, inngestEnvSchema, openAIEnvSchema } from "@stackprep/shared";
import { createClient } from "@supabase/supabase-js";
import { createOpenAIEmbeddingProvider, createOpenAIProvider } from "../_shared/ai/openai.ts";
import { createSupabaseAuthenticator } from "../_shared/auth.ts";
import { readEnv } from "../_shared/env.ts";
import { createGithubApp } from "../_shared/github-app.ts";
import { createInngestClient } from "../_shared/inngest.ts";
import { createInngestJobQueue } from "../_shared/jobs.ts";
import { createRealtimeClient } from "../_shared/realtime/openai-realtime.ts";
import { initSentry, withSentry } from "../_shared/sentry.ts";
import { createInterviewReader, createInterviewsHandler, createInterviewStore } from "./handler.ts";
import { createReportJobStore } from "./report-request.ts";

/** Fallback only: evaluate_answer and frame checks set their own per-attempt timeouts and retries. */
const EVALUATION_TIMEOUT_MS = 20_000;

initSentry("interviews");
const env = readEnv(
  "interviews function",
  edgeEnvSchema
    .extend(edgeSupabaseEnvSchema.shape)
    .extend(openAIEnvSchema.shape)
    .extend(inngestEnvSchema.shape)
    .extend(
      githubAppEnvSchema.pick({
        GITHUB_APP_ID: true,
        GITHUB_APP_CLIENT_ID: true,
        GITHUB_APP_CLIENT_SECRET: true,
        GITHUB_APP_PRIVATE_KEY: true,
      }).shape,
    ),
);

const serviceClient = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

Deno.serve(withSentry(
  createInterviewsHandler({
    webOrigin: env.WEB_ORIGIN,
    authenticate: createSupabaseAuthenticator(env),
    reader: createInterviewReader,
    store: createInterviewStore(serviceClient),
    realtime: createRealtimeClient({ apiKey: env.OPENAI_API_KEY }),
    model: env.OPENAI_REALTIME_MODEL,
    transcriptionModel: env.OPENAI_REALTIME_TRANSCRIPTION_MODEL,
    github: createGithubApp({
      appId: env.GITHUB_APP_ID,
      clientId: env.GITHUB_APP_CLIENT_ID,
      clientSecret: env.GITHUB_APP_CLIENT_SECRET,
      privateKeyPem: env.GITHUB_APP_PRIVATE_KEY,
    }),
    ai: createOpenAIProvider({ apiKey: env.OPENAI_API_KEY, timeoutMs: EVALUATION_TIMEOUT_MS }),
    evaluationModel: env.OPENAI_EVALUATION_MODEL,
    evaluationReasoningEffort: env.OPENAI_EVALUATION_REASONING_EFFORT,
    // No provider timeout: search_repository bounds the whole vector fill with one shared deadline.
    embeddings: { provider: createOpenAIEmbeddingProvider({ apiKey: env.OPENAI_API_KEY }), model: env.OPENAI_EMBEDDING_MODEL },
    visionModel: env.OPENAI_VISION_MODEL,
    visionReasoningEffort: env.OPENAI_VISION_REASONING_EFFORT,
    jobs: createInngestJobQueue(createInngestClient(env)),
    reportJobs: createReportJobStore(serviceClient),
  }),
  { webOrigin: env.WEB_ORIGIN },
));
