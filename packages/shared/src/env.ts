import { z } from "zod";

const nodeEnv = z.enum(["development", "test", "production"]);

const httpUrl = z.url({ protocol: /^https?$/ });

const secret = z.string().trim().min(1);

export const webEnvSchema = z.object({
  NODE_ENV: nodeEnv,
  NEXT_PUBLIC_SUPABASE_URL: httpUrl,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: secret,
});

export const webSentryEnvSchema = z.object({
  NEXT_PUBLIC_SENTRY_DSN: httpUrl,
  SENTRY_ORG: secret.optional(),
  SENTRY_PROJECT: secret.optional(),
  SENTRY_AUTH_TOKEN: secret.optional(),
});

export const webGithubAppEnvSchema = z.object({
  NEXT_PUBLIC_GITHUB_APP_SLUG: secret,
});

export const edgeEnvSchema = z.object({
  WEB_ORIGIN: httpUrl,
});

export const edgeSupabaseEnvSchema = z.object({
  SUPABASE_URL: httpUrl,
  SUPABASE_ANON_KEY: secret,
  SUPABASE_SERVICE_ROLE_KEY: secret,
});

export const inngestEnvSchema = z.object({
  INNGEST_EVENT_KEY: secret,
  INNGEST_SIGNING_KEY: secret,
});

export const openAIEnvSchema = z.object({
  OPENAI_API_KEY: secret,
  OPENAI_PLANNING_MODEL: secret.default("gpt-6.1-sol"),
  
  OPENAI_EVALUATION_MODEL: secret.default("gpt-6-luna"),
  OPENAI_REALTIME_MODEL: secret.default("gpt-realtime-2.1-mini"),
 
  OPENAI_REALTIME_TRANSCRIPTION_MODEL: secret.default("gpt-live-transcribe"),
  
  OPENAI_VISION_MODEL: secret.default("gpt-6-luna"),
 
  OPENAI_EMBEDDING_MODEL: secret.default("text-embedding-3-small"),
});

export const githubAppEnvSchema = z.object({
  GITHUB_APP_ID: z.string().regex(/^\d+$/, "Expected a numeric GitHub App id"),
  GITHUB_APP_CLIENT_ID: secret,
  GITHUB_APP_CLIENT_SECRET: secret,
  GITHUB_APP_PRIVATE_KEY: secret.refine(
    (pem) => pem.includes("-----BEGIN PRIVATE KEY-----") && pem.includes("-----END PRIVATE KEY-----"),
    "Expected a PKCS#8 PEM (convert with openssl pkcs8 -topk8 -nocrypt)",
  ),
  GITHUB_APP_WEBHOOK_SECRET: secret,
});

export const edgeSentryEnvSchema = z.object({
  SENTRY_DSN: httpUrl,
  SENTRY_ENVIRONMENT: secret.default("development"),
});

export type WebEnv = z.infer<typeof webEnvSchema>;
export type WebSentryEnv = z.infer<typeof webSentryEnvSchema>;
export type WebGithubAppEnv = z.infer<typeof webGithubAppEnvSchema>;
export type EdgeEnv = z.infer<typeof edgeEnvSchema>;
export type EdgeSupabaseEnv = z.infer<typeof edgeSupabaseEnvSchema>;
export type InngestEnv = z.infer<typeof inngestEnvSchema>;
export type OpenAIEnv = z.infer<typeof openAIEnvSchema>;
export type GithubAppEnv = z.infer<typeof githubAppEnvSchema>;
export type EdgeSentryEnv = z.infer<typeof edgeSentryEnvSchema>;

export function parseEnv<T extends z.ZodType>(
  name: string,
  schema: T,
  source: Record<string, string | undefined>,
): z.infer<T> {
  const result = schema.safeParse(source);
  if (!result.success) {
    throw new Error(`Invalid ${name} environment variables:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
