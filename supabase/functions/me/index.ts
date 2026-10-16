import { byokEnvSchema, edgeEnvSchema, edgeSupabaseEnvSchema, openAIModelEnvSchema } from "@stackprep/shared";
import { createClient } from "@supabase/supabase-js";
import { loadKeyring } from "../_shared/ai/keyring.ts";
import { createKeyValidator } from "../_shared/ai/key-validation.ts";
import { createSupabaseAuthenticator } from "../_shared/auth.ts";
import { readEnv } from "../_shared/env.ts";
import { initSentry, withSentry } from "../_shared/sentry.ts";
import { createMeHandler, getProfileWithRls } from "./handler.ts";
import { createOpenAIKeyStore } from "./openai-key-store.ts";

initSentry("me");
const env = readEnv(
  "me function",
  edgeEnvSchema.extend(edgeSupabaseEnvSchema.shape).extend(byokEnvSchema.shape).extend(openAIModelEnvSchema.shape),
);

const serviceClient = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});
const keyring = await loadKeyring(env.OPENAI_KEY_ENCRYPTION_KEYS, env.OPENAI_KEY_ENCRYPTION_ACTIVE_VERSION);

Deno.serve(withSentry(
  createMeHandler({
    webOrigin: env.WEB_ORIGIN,
    authenticate: createSupabaseAuthenticator(env),
    getProfile: getProfileWithRls,
    openAIKeys: createOpenAIKeyStore(serviceClient, keyring),
    validateKey: createKeyValidator({
      models: [
        env.OPENAI_REALTIME_MODEL,
        env.OPENAI_PLANNING_MODEL,
        env.OPENAI_EVALUATION_MODEL,
        env.OPENAI_REPORT_MODEL,
        env.OPENAI_VISION_MODEL,
      ],
      embeddingModel: env.OPENAI_EMBEDDING_MODEL,
      transcriptionModel: env.OPENAI_REALTIME_TRANSCRIPTION_MODEL,
    }),
  }),
  { webOrigin: env.WEB_ORIGIN },
));
