import { assertEquals, assertStrictEquals } from "@std/assert";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { bearerToken, createAuthenticator } from "./auth.ts";

const alice = { id: "aaaaaaaa-0000-4000-8000-000000000001", is_anonymous: false } as User;
const fakeClient = {} as SupabaseClient;

function request(authorization?: string) {
  return new Request("http://localhost/me", {
    headers: authorization ? { Authorization: authorization } : {},
  });
}

const authenticate = createAuthenticator({
  verifyToken: (token) => Promise.resolve(token === "valid" ? alice : token === "anon-user" ? { ...alice, is_anonymous: true } : null),
  userClient: () => fakeClient,
});

Deno.test("bearerToken parses the Authorization header", () => {
  assertEquals(bearerToken(request("Bearer abc.def")), "abc.def");
  assertEquals(bearerToken(request("bearer abc")), "abc");
  assertEquals(bearerToken(request("Basic abc")), null);
  assertEquals(bearerToken(request("Bearer")), null);
  assertEquals(bearerToken(request()), null);
});

Deno.test("missing token is unauthenticated", async () => {
  assertEquals(await authenticate(request()), null);
});

Deno.test("invalid token is unauthenticated", async () => {
  assertEquals(await authenticate(request("Bearer forged")), null);
});

Deno.test("anonymous users are unauthenticated", async () => {
  assertEquals(await authenticate(request("Bearer anon-user")), null);
});

Deno.test("valid token yields the user and a user-scoped client", async () => {
  const ctx = await authenticate(request("Bearer valid"));
  assertEquals(ctx?.user.id, alice.id);
  assertStrictEquals(ctx?.supabase, fakeClient);
});
