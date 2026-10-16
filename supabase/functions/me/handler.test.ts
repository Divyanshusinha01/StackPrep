import { assert, assertEquals } from "@std/assert";
import { maskOpenAIKey, type OpenAIKeyErrorCode, type OpenAIKeyStatus, profileResponseSchema } from "@stackprep/shared";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import type { OpenAICredentialStatusRow } from "../_shared/ai/credentials.ts";
import type { KeyValidationResult } from "../_shared/ai/key-validation.ts";
import type { Authenticate } from "../_shared/auth.ts";
import { createMeHandler } from "./handler.ts";
import type { OpenAIKeyStore } from "./openai-key-store.ts";

const userId = "aaaaaaaa-0000-4000-8000-000000000001";
const otherUserId = "aaaaaaaa-0000-4000-8000-000000000002";
const url = "http://localhost/me";
const keyUrl = "http://localhost/me/openai-key";
const validateUrl = "http://localhost/me/openai-key/validate";
const OLD_KEY = "sk-proj-OLDOLDOLDOLDOLDOLDOLDOLD1111";
const NEW_KEY = "sk-proj-NEWNEWNEWNEWNEWNEWNEWNEW2222";

const authenticate: Authenticate = (req) => {
  const token = req.headers.get("Authorization");
  const id = token === "Bearer valid" ? userId : token === "Bearer other" ? otherUserId : null;
  return Promise.resolve(id ? { user: { id } as User, supabase: {} as SupabaseClient } : null);
};

interface Row {
  apiKey: string;
  credentialId: string;
  status: OpenAIKeyStatus;
  code: OpenAIKeyErrorCode | null;
}

function fakeKeys(initial: Record<string, Row> = {}, attemptLimit = 5) {
  const rows = new Map(Object.entries(initial));
  const attempts = new Map<string, number>();
  const validated: string[] = [];
  let next = 0;
  const store: OpenAIKeyStore = {
    getStatus(id) {
      const row = rows.get(id);
      const status: OpenAICredentialStatusRow | null = row
        ? { status: row.status, key_hint: maskOpenAIKey(row.apiKey), validated_at: "2026-10-16T10:00:00+00:00", last_error_code: row.code }
        : null;
      return Promise.resolve(status);
    },
    reserveAttempt(id) {
      const used = attempts.get(id) ?? 0;
      attempts.set(id, used + 1);
      return Promise.resolve(used < attemptLimit);
    },
    save(id, apiKey) {
      rows.set(id, { apiKey, credentialId: `cred-${++next}`, status: "valid", code: null });
      return Promise.resolve();
    },
    load(id) {
      const row = rows.get(id);
      return Promise.resolve(row ? { apiKey: row.apiKey, credentialId: row.credentialId } : null);
    },
    markStatus(id, credentialId, status, code) {
      const row = rows.get(id);
      if (!row || row.credentialId !== credentialId) {
        return Promise.resolve(false);
      }
      rows.set(id, { ...row, status, code });
      return Promise.resolve(true);
    },
    delete(id) {
      return Promise.resolve(rows.delete(id));
    },
  };
  return { store, rows, attempts, validated };
}

function makeHandler(keys = fakeKeys(), verdict: (key: string) => KeyValidationResult = () => ({ outcome: "valid" })) {
  return createMeHandler({
    webOrigin: "http://localhost:3000",
    authenticate,
    getProfile: ({ user }) =>
      Promise.resolve({ id: user.id, github_login: "alice", display_name: "Alice", avatar_url: null }),
    openAIKeys: keys.store,
    validateKey: (key) => {
      keys.validated.push(key);
      return Promise.resolve(verdict(key));
    },
  });
}

function put(apiKey: unknown, token = "valid") {
  return new Request(keyUrl, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: apiKey }),
  });
}

const authed = (input: string, init: RequestInit = {}, token = "valid") =>
  new Request(input, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } });

Deno.test("unauthenticated requests get 401", async () => {
  const handler = makeHandler();
  for (const req of [new Request(url), new Request(keyUrl), new Request(keyUrl, { method: "DELETE" }), put(NEW_KEY, "nope")]) {
    const res = await handler(req);
    assertEquals(res.status, 401);
    assertEquals(res.headers.get("access-control-allow-origin"), "http://localhost:3000");
  }
});

Deno.test("authenticated requests get their own profile", async () => {
  const res = await makeHandler()(authed(url));
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
    openAIKeys: fakeKeys().store,
    validateKey: () => Promise.resolve({ outcome: "valid" }),
  });
  const res = await missing(authed(url));
  assertEquals(res.status, 404);
});

Deno.test("OPTIONS preflight does not require auth and allows the key methods", async () => {
  const res = await makeHandler()(new Request(keyUrl, { method: "OPTIONS", headers: { Origin: "http://localhost:3000" } }));
  assertEquals(res.status, 204);
  assert(res.headers.get("access-control-allow-headers")?.includes("authorization"));
  assertEquals(res.headers.get("access-control-allow-methods"), "GET, PUT, POST, DELETE, OPTIONS");
});

Deno.test("rejects other origins before authenticating", async () => {
  const res = await makeHandler()(new Request(url, { headers: { Origin: "https://evil.example", Authorization: "Bearer valid" } }));
  assertEquals(res.status, 403);
});

Deno.test("rejects unsupported methods per route", async () => {
  const handler = makeHandler();
  assertEquals((await handler(authed(url, { method: "POST" }))).status, 405);
  assertEquals((await handler(authed(keyUrl, { method: "POST" }))).status, 405);
  assertEquals((await handler(authed(validateUrl))).status, 405);
  assertEquals((await handler(authed("http://localhost/me/other"))).status, 404);
});

Deno.test("GET reports not configured, then status and hint only", async () => {
  const keys = fakeKeys();
  const handler = makeHandler(keys);
  assertEquals(await (await handler(authed(keyUrl))).json(), { configured: false });

  await handler(put(NEW_KEY));
  const res = await handler(authed(keyUrl));
  const text = await res.text();
  assertEquals(JSON.parse(text), {
    configured: true,
    status: "valid",
    key_hint: "sk-...2222",
    validated_at: "2026-10-16T10:00:00+00:00",
    last_error_code: null,
  });
  assert(!text.includes(NEW_KEY));
  assertEquals(res.headers.get("cache-control"), "no-store");
});

Deno.test("PUT validates, stores, and returns only the hint", async () => {
  const keys = fakeKeys();
  const res = await makeHandler(keys)(put(`  ${NEW_KEY}  `));
  assertEquals(res.status, 200);
  const text = await res.text();
  assert(!text.includes(NEW_KEY));
  assertEquals(JSON.parse(text).key_hint, "sk-...2222");
  assertEquals(keys.validated, [NEW_KEY]);
  assertEquals(keys.rows.get(userId)?.apiKey, NEW_KEY);
});

Deno.test("PUT rejects malformed and admin keys before spending an attempt", async () => {
  const keys = fakeKeys();
  const handler = makeHandler(keys);
  for (const body of ["not-a-key", "sk-short", "sk-admin-AAAAAAAAAAAAAAAAAAAAAAAA", 42]) {
    const res = await handler(put(body));
    assertEquals(res.status, 400);
    assertEquals((await res.json()).code, "invalid_request");
  }
  const extra = await handler(
    authed(keyUrl, { method: "PUT", body: JSON.stringify({ api_key: NEW_KEY, user_id: otherUserId }) }),
  );
  assertEquals(extra.status, 400);
  assertEquals(keys.attempts.size, 0);
  assertEquals(keys.validated, []);
});

Deno.test("a failed replacement leaves the previous key active", async () => {
  const cases: [KeyValidationResult, number, string][] = [
    [{ outcome: "unusable", status: "invalid", code: "invalid_api_key" }, 409, "openai_key_invalid"],
    [{ outcome: "unusable", status: "quota_exhausted", code: "insufficient_quota" }, 409, "openai_quota_exhausted"],
    [{ outcome: "unusable", status: "permission_denied", code: "permission_denied", model: "gpt-x" }, 409, "openai_key_permission_denied"],
    [{ outcome: "rate_limited", retryAfterSeconds: 7 }, 429, "openai_rate_limited"],
    [{ outcome: "unavailable" }, 502, "openai_unavailable"],
  ];
  for (const [verdict, status, code] of cases) {
    const keys = fakeKeys({ [userId]: { apiKey: OLD_KEY, credentialId: "cred-old", status: "valid", code: null } });
    const res = await makeHandler(keys, () => verdict)(put(NEW_KEY));
    assertEquals(res.status, status);
    const text = await res.text();
    const body = JSON.parse(text);
    assertEquals(body.code, code);
    assert(!text.includes(NEW_KEY));
    if (code === "openai_key_permission_denied") {
      assertEquals(body.model, "gpt-x");
    }
    if (code === "openai_rate_limited") {
      assertEquals(res.headers.get("retry-after"), "7");
    }
    assertEquals(keys.rows.get(userId), { apiKey: OLD_KEY, credentialId: "cred-old", status: "valid", code: null });
  }
});

Deno.test("save and validate share a per-user rate limit", async () => {
  const keys = fakeKeys({}, 2);
  const handler = makeHandler(keys);
  assertEquals((await handler(put(NEW_KEY))).status, 200);
  assertEquals((await handler(authed(validateUrl, { method: "POST" }))).status, 200);
  const limited = await handler(put(NEW_KEY));
  assertEquals(limited.status, 429);
  assertEquals((await limited.json()).code, "rate_limited");
  assertEquals(limited.headers.get("retry-after"), "600");
  assertEquals((await handler(authed(validateUrl, { method: "POST" }))).status, 429);
  assertEquals(keys.validated.length, 2);

  assertEquals((await handler(put(NEW_KEY, "other"))).status, 200);
});

Deno.test("POST validate re-checks the stored key and updates its status", async () => {
  const keys = fakeKeys({ [userId]: { apiKey: OLD_KEY, credentialId: "cred-old", status: "valid", code: null } });
  let verdict: KeyValidationResult = { outcome: "unusable", status: "quota_exhausted", code: "insufficient_quota" };
  const handler = makeHandler(keys, () => verdict);

  const failed = await handler(authed(validateUrl, { method: "POST" }));
  assertEquals(failed.status, 409);
  assertEquals((await failed.json()).code, "openai_quota_exhausted");
  assertEquals(keys.rows.get(userId)?.status, "quota_exhausted");
  assertEquals(keys.validated, [OLD_KEY]);

  verdict = { outcome: "valid" };
  const ok = await handler(authed(validateUrl, { method: "POST" }));
  assertEquals(ok.status, 200);
  assertEquals((await ok.json()).status, "valid");
  assertEquals(keys.rows.get(userId)?.code, null);

  verdict = { outcome: "unavailable" };
  assertEquals((await handler(authed(validateUrl, { method: "POST" }))).status, 502);
  assertEquals(keys.rows.get(userId)?.status, "valid");
});

Deno.test("POST validate without a stored key is openai_key_required", async () => {
  const res = await makeHandler()(authed(validateUrl, { method: "POST" }));
  assertEquals(res.status, 409);
  assertEquals((await res.json()).code, "openai_key_required");
});

Deno.test("DELETE removes only the caller's key", async () => {
  const keys = fakeKeys({
    [userId]: { apiKey: OLD_KEY, credentialId: "a", status: "valid", code: null },
    [otherUserId]: { apiKey: NEW_KEY, credentialId: "b", status: "valid", code: null },
  });
  const handler = makeHandler(keys);
  const res = await handler(authed(keyUrl, { method: "DELETE" }));
  assertEquals(res.status, 204);
  assertEquals(keys.rows.has(userId), false);
  assertEquals(keys.rows.has(otherUserId), true);
  assertEquals((await handler(authed(keyUrl, { method: "DELETE" }))).status, 204);
});

Deno.test("store failures are internal errors that never echo the key", async () => {
  const keys = fakeKeys();
  keys.store.save = () => Promise.reject(new Error("db down"));
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    const res = await makeHandler(keys)(put(NEW_KEY));
    assertEquals(res.status, 500);
    assert(!(await res.text()).includes(NEW_KEY));
  } finally {
    console.error = original;
  }
  assert(lines.every((line) => !line.includes(NEW_KEY)));
});
