import { healthResponseSchema } from "@stackprep/shared";
import { env } from "@/env";

interface Schema<T> {
  parse(data: unknown): T;
}

async function apiGet<T>(path: string, schema: Schema<T>, init?: RequestInit): Promise<T> {
  const res = await fetch(new URL(path, env.NEXT_PUBLIC_API_URL), init);
  if (!res.ok) {
    throw new Error(`API ${path} responded ${res.status}`);
  }
  return schema.parse(await res.json());
}

export function getHealth() {
  return apiGet("/health", healthResponseSchema, { cache: "no-store" });
}
