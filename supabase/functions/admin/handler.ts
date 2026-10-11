import {
  ADMIN_INTERVIEW_COST_LIMIT,
  type AdminMetricsResponse,
  adminMetricsResponseSchema,
  type AdminWindowDays,
  adminWindowDaysSchema,
  DEFAULT_ADMIN_WINDOW_DAYS,
  isAdminUserId,
} from "@stackprep/shared";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Authenticate } from "../_shared/auth.ts";
import { createCors, json } from "../_shared/http.ts";

export type LoadAdminMetrics = (days: AdminWindowDays) => Promise<AdminMetricsResponse>;

export interface AdminHandlerOptions {
  webOrigin: string;
  authenticate: Authenticate;
  adminUserIds: ReadonlySet<string>;
  loadMetrics: LoadAdminMetrics;
}

const ROUTE = /\/admin\/metrics\/?$/;

/**
 * Calls only the four admin_* aggregate functions, with a validated window and a fixed limit.
 * The service-role client never reaches a table or any other function from here.
 */
export function createAdminMetricsLoader(serviceClient: SupabaseClient): LoadAdminMetrics {
  async function call(fn: string, args: Record<string, number>): Promise<unknown[]> {
    const { data, error } = await serviceClient.rpc(fn, args);
    if (error) {
      throw new Error(`${fn} failed: ${error.message}`);
    }
    return (data ?? []) as unknown[];
  }

  return async (days) => {
    const [interviewCost, voiceTextSplit, cacheHitRate, toolLatency] = await Promise.all([
      call("admin_interview_cost", { p_days: days, p_limit: ADMIN_INTERVIEW_COST_LIMIT }),
      call("admin_voice_text_split", { p_days: days }),
      call("admin_cache_hit_rate", { p_days: days }),
      call("admin_tool_latency", { p_days: days }),
    ]);
    return adminMetricsResponseSchema.parse({
      window_days: days,
      interview_cost: interviewCost,
      voice_text_split: voiceTextSplit,
      cache_hit_rate: cacheHitRate,
      tool_latency: toolLatency,
    });
  };
}

export function createAdminHandler({ webOrigin, authenticate, adminUserIds, loadMetrics }: AdminHandlerOptions) {
  const cors = createCors(webOrigin, ["GET"]);
  const notFound = () => json({ error: "Not found", code: "not_found" }, { status: 404, headers: cors.headers });

  return async (req: Request): Promise<Response> => {
    const rejected = cors.rejectOrigin(req);
    if (rejected) {
      return rejected;
    }

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors.headers });
    }

    const url = new URL(req.url);
    if (!ROUTE.test(url.pathname)) {
      return notFound();
    }

    if (req.method !== "GET") {
      return json(
        { error: "Method not allowed", code: "method_not_allowed" },
        { status: 405, headers: { ...cors.headers, Allow: "GET, OPTIONS" } },
      );
    }

    const ctx = await authenticate(req);
    if (!ctx) {
      return json({ error: "Unauthorized", code: "unauthorized" }, { status: 401, headers: cors.headers });
    }
    // A signed-in non-admin learns nothing about the endpoint.
    if (!isAdminUserId(adminUserIds, ctx.user.id)) {
      return notFound();
    }

    const rawDays = url.searchParams.get("days");
    const days = adminWindowDaysSchema.safeParse(rawDays ?? DEFAULT_ADMIN_WINDOW_DAYS);
    if (!days.success) {
      return json({ error: "Unsupported window", code: "invalid_request" }, { status: 400, headers: cors.headers });
    }

    const metrics = await loadMetrics(days.data as AdminWindowDays);
    return json(adminMetricsResponseSchema.parse(metrics), { headers: cors.headers });
  };
}
