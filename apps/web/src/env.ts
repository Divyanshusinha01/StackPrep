import { adminEnvSchema, parseEnv, webEnvSchema } from "@stackprep/shared";

export const env = parseEnv("web", webEnvSchema, {
  NODE_ENV: process.env.NODE_ENV,
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
});

/** Server-only (no NEXT_PUBLIC_ prefix): always empty in client bundles. Read it through `@/lib/admin`. */
export const adminEnv = parseEnv("web admin", adminEnvSchema, {
  ADMIN_USER_IDS: process.env.ADMIN_USER_IDS,
});
