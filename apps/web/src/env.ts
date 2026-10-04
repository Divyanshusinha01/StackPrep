import { parseEnv, webEnvSchema } from "@stackprep/shared";

export const env = parseEnv("web", webEnvSchema, {
  NODE_ENV: process.env.NODE_ENV,
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
});
