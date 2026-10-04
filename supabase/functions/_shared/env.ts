import { parseEnv } from "@stackprep/shared";
import type { z } from "zod";

export function readEnv<T extends z.ZodObject>(name: string, schema: T): z.infer<T> {
  const source = Object.fromEntries(Object.keys(schema.shape).map((key) => [key, Deno.env.get(key)]));
  return parseEnv(name, schema, source);
}
