import { z } from "zod";

const nodeEnv = z.enum(["development", "test", "production"]);

const httpUrl = z.url({ protocol: /^https?$/ });

export const webEnvSchema = z.object({
  NODE_ENV: nodeEnv,
  NEXT_PUBLIC_SUPABASE_URL: httpUrl,
});

export const edgeEnvSchema = z.object({
  WEB_ORIGIN: httpUrl,
});

export type WebEnv = z.infer<typeof webEnvSchema>;
export type EdgeEnv = z.infer<typeof edgeEnvSchema>;

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
