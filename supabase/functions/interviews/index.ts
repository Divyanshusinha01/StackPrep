import { edgeEnvSchema, edgeSupabaseEnvSchema, githubAppEnvSchema, openAIEnvSchema } from "@stackprep/shared";
import { createClient } from "@supabase/supabase-js";
import { createOpenAIProvider } from "../_shared/ai/openai.ts";
import { createSupabaseAuthenticator } from "../_shared/auth.ts";
import { readEnv } from "../_shared/env.ts";
import { createGithubApp } from "../_shared/github-app.ts";
import { createRealtimeClient } from "../_shared/realtime/openai-realtime.ts";
import { createInterviewReader, createInterviewsHandler, createInterviewStore } from "./handler.ts";

/** evaluate_answer runs while the candidate waits for the interviewer to speak. */
const EVALUATION_TIMEOUT_MS = 20_000;

const env = readEnv(
  "interviews function",
  edgeEnvSchema
    .extend(edgeSupabaseEnvSchema.shape)
    .extend(openAIEnvSchema.shape)
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

Deno.serve(
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
  }),
);
