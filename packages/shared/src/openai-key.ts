import { z } from "zod";

// Account-level OpenAI key (bring your own key). One key per user serves all of their workspaces;
// it is stored encrypted server-side and never returned. Only its status and a short hint are.

/**
 * Project and user secret keys. Admin keys (`sk-admin-`) can manage an organization and are
 * never accepted.
 */
export const OPENAI_KEY_PATTERN = /^sk-[A-Za-z0-9_-]{20,200}$/;

export const openAIKeySchema = z
  .string()
  .trim()
  .regex(OPENAI_KEY_PATTERN)
  .refine((key) => !key.startsWith("sk-admin-"), "Admin keys are not accepted");

export const openAIKeyStatusSchema = z.enum(["valid", "invalid", "quota_exhausted", "permission_denied"]);

/** Why the key was last rejected; never the provider's message. */
export const openAIKeyErrorCodeSchema = z.enum([
  "invalid_api_key",
  "insufficient_quota",
  "permission_denied",
  "model_unavailable",
]);

/** `sk-...` plus the last 4 characters. */
export const openAIKeyHintSchema = z.string().regex(/^sk-\.\.\.[A-Za-z0-9_-]{4}$/);

export function maskOpenAIKey(key: string): string {
  return `sk-...${key.slice(-4)}`;
}

const SECRET_KEY_LIKE = /sk-[A-Za-z0-9_-]{8,}/g;
const MAX_REDACT_DEPTH = 20;

/**
 * Replaces anything shaped like an OpenAI secret key in every string of a JSON-like value, in
 * place for objects and arrays. For error-reporting hooks; hints (`sk-...abcd`) are left alone.
 */
export function redactOpenAIKeys<T>(value: T): T {
  return redact(value, 0) as T;
}

function redact(value: unknown, depth: number): unknown {
  if (typeof value === "string") {
    return value.replace(SECRET_KEY_LIKE, "sk-[redacted]");
  }
  if (depth >= MAX_REDACT_DEPTH || value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      value[i] = redact(value[i], depth + 1);
    }
    return value;
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    record[key] = redact(record[key], depth + 1);
  }
  return value;
}

// PUT /me/openai-key ----------------------------------------------------------

export const saveOpenAIKeyRequestSchema = z.strictObject({
  api_key: openAIKeySchema,
});

// GET /me/openai-key (also the success body of PUT and POST /validate) ------------------

export const openAIKeyStatusResponseSchema = z.discriminatedUnion("configured", [
  z.object({ configured: z.literal(false) }),
  z.object({
    configured: z.literal(true),
    status: openAIKeyStatusSchema,
    key_hint: openAIKeyHintSchema,
    validated_at: z.iso.datetime({ offset: true }).nullable(),
    last_error_code: openAIKeyErrorCodeSchema.nullable(),
  }),
]);

export type OpenAIKeyStatus = z.infer<typeof openAIKeyStatusSchema>;
export type OpenAIKeyErrorCode = z.infer<typeof openAIKeyErrorCodeSchema>;
export type SaveOpenAIKeyRequest = z.infer<typeof saveOpenAIKeyRequestSchema>;
export type OpenAIKeyStatusResponse = z.infer<typeof openAIKeyStatusResponseSchema>;
