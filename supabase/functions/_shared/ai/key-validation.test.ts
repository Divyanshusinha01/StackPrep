import { assert, assertEquals } from "@std/assert";
import { createKeyValidator } from "./key-validation.ts";

const API_KEY = "sk-proj-abcdefghijklmnopqrstuvwxyz0123";
const models = { models: ["gpt-a", "gpt-b", "gpt-a"], embeddingModel: "embed-1", transcriptionModel: "transcribe-1" };

type Route = (url: string) => Response;

function validator(route: Route) {
  const calls: { url: string; auth: string | null }[] = [];
  const fetchFn = ((url: string, init: RequestInit = {}) => {
    calls.push({ url, auth: new Headers(init.headers).get("Authorization") });
    return Promise.resolve(route(url));
  }) as typeof fetch;
  return { validate: createKeyValidator({ ...models, fetch: fetchFn }), calls };
}

const ok: Route = (url) => {
  if (url.includes("/embeddings")) {
    return Response.json({ data: [{ index: 0, embedding: [0.1] }], usage: { prompt_tokens: 1 } });
  }
  if (url.includes("/client_secrets")) {
    return Response.json({ value: "ek_test", expires_at: 4_000_000_000 });
  }
  return Response.json({ id: "model" });
};

function failing(status: number, error: Record<string, unknown>, headers: Record<string, string> = {}) {
  return Response.json({ error: { message: `Incorrect API key provided: ${API_KEY}`, ...error } }, { status, headers });
}

Deno.test("a working key checks each distinct model, one embedding, and one transcription mint", async () => {
  const { validate, calls } = validator(ok);
  assertEquals(await validate(API_KEY, "user-hash"), { outcome: "valid" });
  assertEquals(calls.map((c) => c.url), [
    "https://api.openai.com/v1/models/gpt-a",
    "https://api.openai.com/v1/models/gpt-b",
    "https://api.openai.com/v1/models/embed-1",
    "https://api.openai.com/v1/models/transcribe-1",
    "https://api.openai.com/v1/embeddings",
    "https://api.openai.com/v1/realtime/client_secrets",
  ]);
  assert(calls.every((c) => c.auth === `Bearer ${API_KEY}`));
});

Deno.test("401 is invalid and stops further checks", async () => {
  const { validate, calls } = validator(() => failing(401, { code: "invalid_api_key" }));
  assertEquals(await validate(API_KEY, "u"), { outcome: "unusable", status: "invalid", code: "invalid_api_key" });
  assertEquals(calls.length, 1);
});

Deno.test("403 or 404 on a model names only the model", async () => {
  const denied = validator((url) => url.endsWith("/gpt-b") ? failing(403, {}) : ok(url));
  const result = await denied.validate(API_KEY, "u");
  assertEquals(result, { outcome: "unusable", status: "permission_denied", code: "permission_denied", model: "gpt-b" });
  assert(!JSON.stringify(result).includes(API_KEY));

  const missing = validator((url) => url.endsWith("/gpt-a") ? failing(404, { code: "model_not_found" }) : ok(url));
  assertEquals(await missing.validate(API_KEY, "u"), {
    outcome: "unusable",
    status: "permission_denied",
    code: "model_unavailable",
    model: "gpt-a",
  });
});

Deno.test("insufficient_quota on the embedding is quota_exhausted", async () => {
  const { validate } = validator((url) =>
    url.includes("/embeddings") ? failing(429, { code: "insufficient_quota", type: "insufficient_quota" }) : ok(url)
  );
  assertEquals(await validate(API_KEY, "u"), { outcome: "unusable", status: "quota_exhausted", code: "insufficient_quota" });
});

Deno.test("Realtime permission failures and rate limits are reported", async () => {
  const denied = validator((url) => url.includes("/client_secrets") ? failing(403, {}) : ok(url));
  assertEquals(await denied.validate(API_KEY, "u"), {
    outcome: "unusable",
    status: "permission_denied",
    code: "permission_denied",
    model: "transcribe-1",
  });

  const limited = validator((url) =>
    url.includes("/client_secrets") ? failing(429, { code: "rate_limit_exceeded" }, { "Retry-After": "9" }) : ok(url)
  );
  assertEquals(await limited.validate(API_KEY, "u"), { outcome: "rate_limited", retryAfterSeconds: 9 });
});

Deno.test("outages and network errors are unavailable, not a verdict on the key", async () => {
  assertEquals(await validator(() => new Response("down", { status: 503 })).validate(API_KEY, "u"), { outcome: "unavailable" });
  const fetchFn = (() => Promise.reject(new TypeError("reset"))) as typeof fetch;
  assertEquals(await createKeyValidator({ ...models, fetch: fetchFn })(API_KEY, "u"), { outcome: "unavailable" });
});

Deno.test("the key never appears in console output", async () => {
  const lines: string[] = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    await validator(() => failing(401, {})).validate(API_KEY, "u");
    await validator((url) => url.includes("/embeddings") ? failing(429, { code: "insufficient_quota" }) : ok(url)).validate(API_KEY, "u");
  } finally {
    Object.assign(console, original);
  }
  assert(lines.every((line) => !line.includes(API_KEY)));
});
