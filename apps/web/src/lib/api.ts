import { healthResponseSchema } from "@stackprep/shared";
import { createSupabaseServerClient } from "@/lib/supabase/server";

interface Schema<T> {
  parse(data: unknown): T;
}

async function functionGet<T>(name: string, schema: Schema<T>): Promise<T> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.functions.invoke(name, { method: "GET" });
  if (error) {
    throw new Error(`Edge Function ${name} failed: ${error.message}`);
  }
  return schema.parse(data);
}

export function getHealth() {
  return functionGet("health", healthResponseSchema);
}
