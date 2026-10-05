import type { Inngest, InngestFunction } from "inngest";
import { serve } from "inngest/edge";

/** The Edge runtime strips this prefix from `req.url`, so the SDK cannot infer it when syncing. */
const SERVE_PATH = "/functions/v1/inngest";

/**
 * Inngest calls this endpoint to sync functions and execute each step. Requests are
 * authenticated by the Inngest signing key, not a Supabase JWT.
 */
export function createInngestHandler(client: Inngest.Any, functions: InngestFunction.Any[]) {
  return serve({ client, functions, servePath: SERVE_PATH });
}
