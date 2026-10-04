import { assert, assertEquals } from "@std/assert";
import { profileResponseSchema } from "@stackprep/shared";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import type { Authenticate } from "../_shared/auth.ts";
import { createMeHandler } from "./handler.ts";

const userId = "aaaaaaaa-0000-4000-8000-000000000001";
const url = "http://localhost/me";

const authenticate: Authenticate = (req) =>
  Promise.resolve(
    req.headers.get("Authorization") === "Bearer valid"
      ? { user: { id: userId } as User, supabase: {} as SupabaseClient }
      : null,
  );

const handler = createMeHandler({
  webOrigin: "http://localhost:3000",
  authenticate,
  getProfile: ({ user }) =>
    Promise.resolve({ id: user.id, github_login: "alice", display_name: "Alice", avatar_url: null }),
});

Deno.test("unauthenticated requests get 401", async () => {
  const res = await handler(new Request(url));
  assertEquals(res.status, 401);
  assertEquals(res.headers.get("access-control-allow-origin"), "http://localhost:3000");
});

Deno.test("authenticated requests get their own profile", async () => {
  const res = await handler(new Request(url, { headers: { Authorization: "Bearer valid" } }));
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("cache-control"), "no-store");
  const body = profileResponseSchema.parse(await res.json());
  assertEquals(body.id, userId);
});

Deno.test("missing profile returns 404", async () => {
  const missing = createMeHandler({
    webOrigin: "http://localhost:3000",
    authenticate,
    getProfile: () => Promise.resolve(null),
  });
  const res = await missing(new Request(url, { headers: { Authorization: "Bearer valid" } }));
  assertEquals(res.status, 404);
});

Deno.test("OPTIONS preflight does not require auth", async () => {
  const res = await handler(new Request(url, { method: "OPTIONS", headers: { Origin: "http://localhost:3000" } }));
  assertEquals(res.status, 204);
  assert(res.headers.get("access-control-allow-headers")?.includes("authorization"));
});

Deno.test("rejects other origins before authenticating", async () => {
  const res = await handler(
    new Request(url, { headers: { Origin: "https://evil.example", Authorization: "Bearer valid" } }),
  );
  assertEquals(res.status, 403);
});

Deno.test("rejects unsupported methods", async () => {
  const res = await handler(new Request(url, { method: "POST", headers: { Authorization: "Bearer valid" } }));
  assertEquals(res.status, 405);
});
