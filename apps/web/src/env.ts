import { adminEnvSchema, parseEnv, webEnvSchema } from "@stackprep/shared";

export const env = parseEnv("web", webEnvSchema, {
  NODE_ENV: process.env.NODE_ENV,
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL || undefined,
});

// A production deploy without it would publish localhost canonical and og:image URLs.
if (process.env.VERCEL_ENV === "production" && !env.NEXT_PUBLIC_SITE_URL) {
  throw new Error("Invalid web environment variables:\nNEXT_PUBLIC_SITE_URL is required for production deploys");
}

/** Server-only (no NEXT_PUBLIC_ prefix): always empty in client bundles. Read it through `@/lib/admin`. */
export const adminEnv = parseEnv("web admin", adminEnvSchema, {
  ADMIN_USER_IDS: process.env.ADMIN_USER_IDS,
});
