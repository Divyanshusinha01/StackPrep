import { z } from "zod";

const nodeEnv = z.enum(["development", "test", "production"]);

const httpUrl = z.url({ protocol: /^https?$/ });

export const webEnvSchema = z.object({
  NODE_ENV: nodeEnv,
  NEXT_PUBLIC_API_URL: httpUrl,
});

export const apiEnvSchema = z.object({
  NODE_ENV: nodeEnv,
  PORT: z.coerce.number().int().min(1).max(65535),
  WEB_ORIGIN: httpUrl,
});

export const workerEnvSchema = z.object({
  NODE_ENV: nodeEnv,
});

export type WebEnv = z.infer<typeof webEnvSchema>;
export type ApiEnv = z.infer<typeof apiEnvSchema>;
export type WorkerEnv = z.infer<typeof workerEnvSchema>;

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
