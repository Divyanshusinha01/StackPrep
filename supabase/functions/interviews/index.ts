import { edgeEnvSchema, edgeSupabaseEnvSchema, openAIEnvSchema } from "@stackprep/shared";
import { createClient } from "@supabase/supabase-js";
import { createSupabaseAuthenticator } from "../_shared/auth.ts";
import { readEnv } from "../_shared/env.ts";
import { createRealtimeClient } from "../_shared/realtime/openai-realtime.ts";
import { createInterviewReader, createInterviewsHandler, createInterviewStore } from "./handler.ts";

const env = readEnv(
  "interviews function",
  edgeEnvSchema.extend(edgeSupabaseEnvSchema.shape).extend(openAIEnvSchema.shape),
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
  }),
);
