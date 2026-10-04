import { healthResponseSchema } from "@stackprep/shared";
import { env } from "@/env";

interface Schema<T> {
  parse(data: unknown): T;
}

async function functionGet<T>(name: string, schema: Schema<T>, init?: RequestInit): Promise<T> {
  const res = await fetch(new URL(`/functions/v1/${name}`, env.NEXT_PUBLIC_SUPABASE_URL), init);
  if (!res.ok) {
    throw new Error(`Edge Function ${name} responded ${res.status}`);
  }
  return schema.parse(await res.json());
}

export function getHealth() {
  return functionGet("health", healthResponseSchema, { cache: "no-store" });
}
