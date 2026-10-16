import { z } from "zod";

const nodeEnv = z.enum(["development", "test", "production"]);

const httpUrl = z.url({ protocol: /^https?$/ });

const secret = z.string().trim().min(1);

const reasoningEffort = z.enum(["default", "none", "minimal", "low", "medium", "high"]);

export const webEnvSchema = z.object({
  NODE_ENV: nodeEnv,
  NEXT_PUBLIC_SUPABASE_URL: httpUrl,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: secret,
  /** Public origin used for canonical URLs, social images, robots.txt and the sitemap. */
  NEXT_PUBLIC_SITE_URL: httpUrl.optional(),
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

/** Model ids and reasoning effort per task. Every call runs on the owning user's own OpenAI key. */
export const openAIModelEnvSchema = z.object({
  OPENAI_PLANNING_MODEL: secret.default("gpt-6.1-sol"),
  /** Scores answers during the live interview (evaluate_answer); latency matters. */
  OPENAI_EVALUATION_MODEL: secret.default("gpt-6-luna"),
  OPENAI_REALTIME_MODEL: secret.default("gpt-realtime-2.1-mini"),
  /**
   * Transcribes the candidate's speech for the live transcript; the interviewer's own transcript is free.
   * Runs in a dedicated WebRTC transcription session (`type: "transcription"`, no turn detection)
   * committed by the browser, so it must support that session type over WebRTC.
   */
  OPENAI_REALTIME_TRANSCRIPTION_MODEL: secret.default("gpt-live-transcribe"),
  /** Checks one low-detail camera frame for integrity signals. */
  OPENAI_VISION_MODEL: secret.default("gpt-6-luna"),
  /**
   * Embeds repository memory and search queries. Must natively produce
   * REPOSITORY_MEMORY_EMBEDDING_DIMENSIONS-sized vectors: output is never truncated, and a
   * mismatching model fails at runtime instead of writing embeddings.
   */
  OPENAI_EMBEDDING_MODEL: secret.default("text-embedding-3-small"),
  /** Writes the post-interview report. Defaults to the evaluation model; set separately to resize either. */
  OPENAI_REPORT_MODEL: secret.default("gpt-6-luna"),
  /**
   * Reasoning effort per task; hidden reasoning tokens dominate latency. "default" omits the
   * parameter for models that do not accept it. Deep analysis uses the planning effort.
   */
  OPENAI_PLANNING_REASONING_EFFORT: reasoningEffort.default("medium"),
  OPENAI_EVALUATION_REASONING_EFFORT: reasoningEffort.default("low"),
  OPENAI_REPORT_REASONING_EFFORT: reasoningEffort.default("low"),
  OPENAI_VISION_REASONING_EFFORT: reasoningEffort.default("low"),
});

const ENCRYPTION_KEY_BYTES = 32;

function isBase64Key(value: string): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    return false;
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding === ENCRYPTION_KEY_BYTES;
}

/** `version:base64` pairs, comma-separated; versions are unique positive integers. */
export function parseEncryptionKeyring(raw: string): Map<number, string> | null {
  const keys = new Map<number, string>();
  for (const entry of raw.split(",")) {
    const [, version, key] = entry.trim().match(/^([1-9][0-9]{0,4}):(.+)$/) ?? [];
    if (!version || !key || !isBase64Key(key) || keys.has(Number(version))) {
      return null;
    }
    keys.set(Number(version), key);
  }
  return keys.size > 0 ? keys : null;
}

/**
 * Master keys for users' stored OpenAI keys (AES-256-GCM). Decryption accepts every listed version;
 * new ciphertext uses the active one, which the keyring loader checks is listed. Never stored in
 * the database.
 */
export const byokEnvSchema = z.object({
  OPENAI_KEY_ENCRYPTION_KEYS: secret.refine(
    (raw) => parseEncryptionKeyring(raw) !== null,
    "Expected comma-separated version:base64 pairs of 32-byte keys (e.g. 1:<openssl rand -base64 32>)",
  ),
  OPENAI_KEY_ENCRYPTION_ACTIVE_VERSION: z.string().trim().regex(/^[1-9][0-9]{0,4}$/).transform(Number),
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
export type OpenAIModelEnv = z.infer<typeof openAIModelEnvSchema>;
export type ByokEnv = z.infer<typeof byokEnvSchema>;
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
