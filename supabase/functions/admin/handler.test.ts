import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  ADMIN_INTERVIEW_COST_LIMIT,
  type AdminMetricsResponse,
  adminMetricsResponseSchema,
  type AdminWindowDays,
  parseAdminUserIds,
} from "@stackprep/shared";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import type { Authenticate } from "../_shared/auth.ts";
import { assertNoSecrets } from "../_shared/testing.ts";
import { createAdminHandler, createAdminMetricsLoader } from "./handler.ts";

const adminId = "aaaaaaaa-0000-4000-8000-000000000001";
const otherId = "bbbbbbbb-0000-4000-8000-000000000002";
const interviewId = "cccccccc-0000-4000-8000-000000000003";
const url = "http://localhost/admin/metrics";

const tokens: Record<string, string> = { admin: adminId, other: otherId };
const authenticate: Authenticate = (req) => {
  const id = tokens[req.headers.get("Authorization")?.replace("Bearer ", "") ?? ""];
  return Promise.resolve(id ? { user: { id } as User, supabase: {} as SupabaseClient } : null);
};

function metrics(days: AdminWindowDays): AdminMetricsResponse {
  return {
    window_days: days,
    interview_cost: [{
      interview_id: interviewId,
      interview_created_at: "2026-10-11T10:00:00Z",
      cost_usd: 1.5,
      voice_cost_usd: 1.25,
      text_cost_usd: 0.25,
      calls: 4,
      unpriced_calls: 0,
      has_estimate: true,
    }],
    voice_text_split: [],
    cache_hit_rate: [],
    tool_latency: [],
  };
}

function setup(adminUserIds = parseAdminUserIds(adminId)) {
  const loaded: AdminWindowDays[] = [];
  const handler = createAdminHandler({
    webOrigin: "http://localhost:3000",
    authenticate,
    adminUserIds,
    loadMetrics: (days) => {
      loaded.push(days);
      return Promise.resolve(metrics(days));
    },
  });
  return { handler, loaded };
}

function get(path = url, token?: string, init: RequestInit = {}) {
  return new Request(path, { ...init, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init.headers } });
}

Deno.test("unauthenticated requests get 401 and load nothing", async () => {
  const { handler, loaded } = setup();
  const res = await handler(get());
  assertEquals(res.status, 401);
  assertEquals(loaded, []);
});

Deno.test("a signed-in non-admin gets 404 and loads nothing", async () => {
  const { handler, loaded } = setup();
  const res = await handler(get(url, "other"));
  assertEquals(res.status, 404);
  assertEquals((await res.json()).code, "not_found");
  assertEquals(loaded, []);
});

Deno.test("an empty or malformed allowlist denies everyone", async () => {
  for (const raw of [undefined, "", `${adminId},admin@example.com`]) {
    const { handler, loaded } = setup(parseAdminUserIds(raw));
    const res = await handler(get(url, "admin"));
    assertEquals(res.status, 404);
    assertEquals(loaded, []);
  }
});

Deno.test("an admin gets the default 7-day window", async () => {
  const { handler, loaded } = setup();
  const res = await handler(get(url, "admin"));
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("cache-control"), "no-store");
  await assertNoSecrets(res);
  const body = adminMetricsResponseSchema.parse(await res.json());
  assertEquals(body.window_days, 7);
  assertEquals(body.interview_cost[0].interview_id, interviewId);
  assertEquals(loaded, [7]);
});

Deno.test("an admin can pick an offered window", async () => {
  const { handler, loaded } = setup();
  const res = await handler(get(`${url}?days=30`, "admin"));
  assertEquals(res.status, 200);
  assertEquals(loaded, [30]);
});

Deno.test("unsupported windows are rejected before loading", async () => {
  const { handler, loaded } = setup();
  for (const days of ["0", "2", "91", "365", "abc", "", "7;select"]) {
    const res = await handler(get(`${url}?days=${encodeURIComponent(days)}`, "admin"));
    assertEquals(res.status, 400, days);
  }
  assertEquals(loaded, []);
});

Deno.test("unknown paths are 404 and other methods 405", async () => {
  const { handler, loaded } = setup();
  assertEquals((await handler(get("http://localhost/admin", "admin"))).status, 404);
  assertEquals((await handler(get("http://localhost/admin/sql", "admin"))).status, 404);
  assertEquals((await handler(get(url, "admin", { method: "POST" }))).status, 405);
  assertEquals(loaded, []);
});

Deno.test("rejects other origins and answers preflight without auth", async () => {
  const { handler } = setup();
  assertEquals((await handler(get(url, "admin", { headers: { Origin: "https://evil.example" } }))).status, 403);
  const preflight = await handler(get(url, undefined, { method: "OPTIONS", headers: { Origin: "http://localhost:3000" } }));
  assertEquals(preflight.status, 204);
});

Deno.test("the loader calls only the four admin functions with fixed arguments", async () => {
  const calls: [string, Record<string, number>][] = [];
  const rows: Record<string, unknown[]> = {
    admin_interview_cost: [{ ...metrics(7).interview_cost[0], cost_usd: "1.5", transcript: "secret" }],
    admin_voice_text_split: [],
    admin_cache_hit_rate: [{ channel: "voice", calls: 2, input_tokens: "100", cached_input_tokens: "40", hit_rate: 0.4 }],
    admin_tool_latency: [],
  };
  const client = {
    rpc: (fn: string, args: Record<string, number>) => {
      calls.push([fn, args]);
      return Promise.resolve({ data: rows[fn], error: null });
    },
  } as unknown as SupabaseClient;

  const result = await createAdminMetricsLoader(client)(90);
  assertEquals(calls.map(([fn]) => fn).sort(), [
    "admin_cache_hit_rate",
    "admin_interview_cost",
    "admin_tool_latency",
    "admin_voice_text_split",
  ]);
  for (const [fn, args] of calls) {
    assertEquals(args, fn === "admin_interview_cost" ? { p_days: 90, p_limit: ADMIN_INTERVIEW_COST_LIMIT } : { p_days: 90 });
  }
  assertEquals(result.interview_cost[0].cost_usd, 1.5);
  assert(!("transcript" in result.interview_cost[0]));
  assertEquals(result.cache_hit_rate[0].cached_input_tokens, 40);
});

Deno.test("the loader surfaces RPC failures", async () => {
  const client = {
    rpc: () => Promise.resolve({ data: null, error: { message: "boom" } }),
  } as unknown as SupabaseClient;
  await assertRejects(() => createAdminMetricsLoader(client)(7), Error, "failed: boom");
});
