import { assert, assertEquals, assertInstanceOf, assertRejects } from "@std/assert";
import type { OpenAIKeyErrorCode, OpenAIKeyStatus } from "@stackprep/shared";
import { RealtimeUnavailableError } from "../realtime/openai-realtime.ts";
import { createOpenAIClients, openAIKeyApiErrorCode, openAIKeyJobErrorCode } from "./clients.ts";
import { encryptOpenAIKey } from "./credential-crypto.ts";
import { loadKeyring } from "./keyring.ts";
import {
  createOpenAICredentialResolver,
  OpenAIKeyMissingError,
  OpenAIKeyUndecryptableError,
  OpenAIKeyUnusableError,
  type OpenAICredentialStore,
  type StoredOpenAICredential,
} from "./credentials.ts";
import { AIAuthError, AIPermissionError, AIQuotaError, AIRateLimitedError } from "./provider.ts";

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const USER = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "33333333-3333-4333-8333-333333333333";
const CREDENTIAL = "22222222-2222-4222-8222-222222222222";
const API_KEY = "sk-proj-abcdefghijklmnopqrstuvwxyz0123";

interface Mark {
  userId: string;
  credentialId: string;
  status: OpenAIKeyStatus;
  code: OpenAIKeyErrorCode | null;
}

async function fakeStore(row: Partial<StoredOpenAICredential> | null = {}) {
  const keyring = await loadKeyring(`1:${KEY}`, 1);
  const sealed = await encryptOpenAIKey(keyring, API_KEY, { userId: USER, credentialId: CREDENTIAL });
  const marks: Mark[] = [];
  let current: StoredOpenAICredential | null = row === null
    ? null
    : { credentialId: CREDENTIAL, ...sealed, status: "valid", ...row };
  const store: OpenAICredentialStore = {
    load: (userId) => Promise.resolve(userId === USER ? current : null),
    getStatus: () => Promise.resolve(null),
    markStatus(userId, credentialId, status, code) {
      marks.push({ userId, credentialId, status, code });
      const applies = userId === USER && current?.credentialId === credentialId;
      if (applies && current) {
        current = { ...current, status };
      }
      return Promise.resolve(applies);
    },
  };
  return { keyring, store, marks, replace: (next: StoredOpenAICredential | null) => (current = next) };
}

Deno.test("resolve returns the decrypted key and credential id", async () => {
  const { keyring, store } = await fakeStore();
  const resolver = createOpenAICredentialResolver(store, keyring);
  assertEquals(await resolver.resolve(USER), { apiKey: API_KEY, credentialId: CREDENTIAL });
});

Deno.test("resolve fails for a missing key, an unusable status, or another user's row", async () => {
  const missing = await fakeStore(null);
  await assertRejects(() => createOpenAICredentialResolver(missing.store, missing.keyring).resolve(USER), OpenAIKeyMissingError);

  const quota = await fakeStore({ status: "quota_exhausted" });
  const err = await assertRejects(() => createOpenAICredentialResolver(quota.store, quota.keyring).resolve(USER));
  assertInstanceOf(err, OpenAIKeyUnusableError);
  assertEquals(err.status, "quota_exhausted");

  const valid = await fakeStore();
  await assertRejects(() => createOpenAICredentialResolver(valid.store, valid.keyring).resolve(OTHER_USER), OpenAIKeyMissingError);
});

Deno.test("resolve fails closed when the ciphertext cannot be decrypted", async () => {
  const swapped = await fakeStore({ credentialId: "44444444-4444-4444-8444-444444444444" });
  const err = await assertRejects(() => createOpenAICredentialResolver(swapped.store, swapped.keyring).resolve(USER));
  assertInstanceOf(err, OpenAIKeyUndecryptableError);
  assert(!err.message.includes(API_KEY));

  const { store } = await fakeStore();
  const otherKeyring = await loadKeyring(`1:${btoa(String.fromCharCode(...new Uint8Array(32).fill(9)))}`, 1);
  await assertRejects(() => createOpenAICredentialResolver(store, otherKeyring).resolve(USER), OpenAIKeyUndecryptableError);
});

function failingClients(error: () => Error) {
  const seenKeys: string[] = [];
  return {
    seenKeys,
    factories: {
      ai(apiKey: string) {
        seenKeys.push(apiKey);
        return { generateStructured: () => Promise.reject(error()) };
      },
      embeddings(apiKey: string) {
        seenKeys.push(apiKey);
        return { embed: () => Promise.reject(error()) };
      },
      search(apiKey: string) {
        seenKeys.push(apiKey);
        return { searchWeb: () => Promise.reject(error()) };
      },
      realtime(apiKey: string) {
        seenKeys.push(apiKey);
        return {
          createClientSecret: () => Promise.reject(error()),
          createTranscriptionClientSecret: () => Promise.reject(error()),
        };
      },
    },
  };
}

const request = { model: "m", system: "s", input: "i", schemaName: "x", schema: {} as never };

Deno.test("forUser builds clients with the owner's key and marks key failures by credential id", async () => {
  const cases: [() => Error, OpenAIKeyStatus, OpenAIKeyErrorCode][] = [
    [() => new AIAuthError(), "invalid", "invalid_api_key"],
    [() => new AIQuotaError(), "quota_exhausted", "insufficient_quota"],
    [() => new AIPermissionError(404, "model_unavailable"), "permission_denied", "model_unavailable"],
    [() => new RealtimeUnavailableError(403, "permission"), "permission_denied", "permission_denied"],
  ];
  for (const [error, status, code] of cases) {
    const { keyring, store, marks } = await fakeStore();
    const { factories, seenKeys } = failingClients(error);
    const clients = await createOpenAIClients(createOpenAICredentialResolver(store, keyring), factories).forUser(USER);
    assertEquals(clients.credentialId, CREDENTIAL);
    assertEquals(seenKeys, [API_KEY, API_KEY, API_KEY, API_KEY]);
    await assertRejects(() => clients.ai.generateStructured(request));
    assertEquals(marks, [{ userId: USER, credentialId: CREDENTIAL, status, code }]);
  }
});

Deno.test("a key failure during web search marks the key like any other call", async () => {
  const { keyring, store, marks } = await fakeStore();
  const { factories } = failingClients(() => new AIAuthError());
  const clients = await createOpenAIClients(createOpenAICredentialResolver(store, keyring), factories).forUser(USER);
  await assertRejects(
    () => clients.search.searchWeb({ model: "m", system: "s", input: "Concept: x", maxToolCalls: 1 }),
    AIAuthError,
  );
  assertEquals(marks, [{ userId: USER, credentialId: CREDENTIAL, status: "invalid", code: "invalid_api_key" }]);
});

Deno.test("rate limits and outages do not change the key status", async () => {
  const { keyring, store, marks } = await fakeStore();
  const { factories } = failingClients(() => new AIRateLimitedError(5));
  const clients = await createOpenAIClients(createOpenAICredentialResolver(store, keyring), factories).forUser(USER);
  await assertRejects(() => clients.embeddings.embed({ model: "e", input: ["x"] }), AIRateLimitedError);
  await assertRejects(() => clients.realtime.createClientSecret({ model: "r", instructions: "", tools: [] }, "id"), AIRateLimitedError);
  assertEquals(marks, []);
});

Deno.test("a stale call cannot mark a replaced key", async () => {
  const { keyring, store, marks, replace } = await fakeStore();
  const { factories } = failingClients(() => new AIAuthError());
  const clients = await createOpenAIClients(createOpenAICredentialResolver(store, keyring), factories).forUser(USER);
  const replacement = await encryptOpenAIKey(keyring, API_KEY, { userId: USER, credentialId: "55555555-5555-4555-8555-555555555555" });
  replace({ credentialId: "55555555-5555-4555-8555-555555555555", ...replacement, status: "valid" });

  await assertRejects(() => clients.ai.generateStructured(request), AIAuthError);
  assertEquals(marks.length, 1);
  assertEquals(await createOpenAICredentialResolver(store, keyring).resolve(USER).then((r) => r.credentialId), "55555555-5555-4555-8555-555555555555");
});

Deno.test("a failing status update never hides the provider error", async () => {
  const { keyring, store } = await fakeStore();
  const logs: Record<string, unknown>[] = [];
  const broken = { ...store, markStatus: () => Promise.reject(new Error("db down")) };
  const { factories } = failingClients(() => new AIAuthError());
  const clients = await createOpenAIClients(createOpenAICredentialResolver(broken, keyring), factories, { log: (e) => logs.push(e) })
    .forUser(USER);
  await assertRejects(() => clients.ai.generateStructured(request), AIAuthError);
  assertEquals(logs, [{ event: "openai_key_status_update_failed", status: "invalid" }]);
});

Deno.test("maps key errors to API and job codes", () => {
  assertEquals(openAIKeyApiErrorCode(new OpenAIKeyMissingError()), "openai_key_required");
  assertEquals(openAIKeyApiErrorCode(new OpenAIKeyUnusableError("invalid")), "openai_key_invalid");
  assertEquals(openAIKeyApiErrorCode(new OpenAIKeyUndecryptableError()), "openai_key_invalid");
  assertEquals(openAIKeyApiErrorCode(new AIQuotaError()), "openai_quota_exhausted");
  assertEquals(openAIKeyApiErrorCode(new AIPermissionError(403, "permission_denied")), "openai_key_permission_denied");
  assertEquals(openAIKeyApiErrorCode(new AIRateLimitedError(3)), null);
  assertEquals(openAIKeyApiErrorCode(new Error("x")), null);

  assertEquals(openAIKeyJobErrorCode(new OpenAIKeyMissingError()), "openai_key_unavailable");
  assertEquals(openAIKeyJobErrorCode(new AIAuthError()), "openai_key_invalid");
  assertEquals(openAIKeyJobErrorCode(new OpenAIKeyUnusableError("permission_denied")), "openai_key_invalid");
  assertEquals(openAIKeyJobErrorCode(new OpenAIKeyUnusableError("quota_exhausted")), "openai_quota_exhausted");
  assertEquals(openAIKeyJobErrorCode(new RealtimeUnavailableError(500, "unavailable")), null);
});
