import { apiEnvSchema, parseEnv } from "@stackprep/shared";

export const env = parseEnv("api", apiEnvSchema, process.env);
