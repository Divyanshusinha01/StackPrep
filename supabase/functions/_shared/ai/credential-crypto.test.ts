import { assert, assertEquals, assertInstanceOf, assertNotEquals, assertRejects } from "@std/assert";
import {
  CredentialDecryptError,
  decryptOpenAIKey,
  encryptOpenAIKey,
  fromPgBytea,
  toPgBytea,
} from "./credential-crypto.ts";
import { loadKeyring } from "./keyring.ts";

const KEY_1 = btoa(String.fromCharCode(...new Uint8Array(32).fill(1)));
const KEY_2 = btoa(String.fromCharCode(...new Uint8Array(32).fill(2)));
const API_KEY = "sk-proj-abcdefghijklmnopqrstuvwxyz0123";
const binding = { userId: "11111111-1111-4111-8111-111111111111", credentialId: "22222222-2222-4222-8222-222222222222" };

Deno.test("round-trips with a fresh IV each time and no plaintext in the ciphertext", async () => {
  const keyring = await loadKeyring(`1:${KEY_1}`, 1);
  const a = await encryptOpenAIKey(keyring, API_KEY, binding);
  const b = await encryptOpenAIKey(keyring, API_KEY, binding);
  assertEquals(a.version, 1);
  assertEquals(a.iv.length, 12);
  assertNotEquals(toPgBytea(a.iv), toPgBytea(b.iv));
  assert(!new TextDecoder().decode(a.ciphertext).includes("sk-proj"));
  assertEquals(await decryptOpenAIKey(keyring, a, binding), API_KEY);
});

Deno.test("a ciphertext bound to another user or credential fails to decrypt", async () => {
  const keyring = await loadKeyring(`1:${KEY_1}`, 1);
  const sealed = await encryptOpenAIKey(keyring, API_KEY, binding);
  await assertRejects(() => decryptOpenAIKey(keyring, sealed, { ...binding, userId: "33333333-3333-4333-8333-333333333333" }), CredentialDecryptError);
  await assertRejects(
    () => decryptOpenAIKey(keyring, sealed, { ...binding, credentialId: "44444444-4444-4444-8444-444444444444" }),
    CredentialDecryptError,
  );
});

Deno.test("tampered ciphertext or IV fails closed", async () => {
  const keyring = await loadKeyring(`1:${KEY_1}`, 1);
  const sealed = await encryptOpenAIKey(keyring, API_KEY, binding);
  const ciphertext = Uint8Array.from(sealed.ciphertext);
  ciphertext[0] ^= 1;
  await assertRejects(() => decryptOpenAIKey(keyring, { ...sealed, ciphertext }, binding), CredentialDecryptError);
  const iv = Uint8Array.from(sealed.iv);
  iv[0] ^= 1;
  await assertRejects(() => decryptOpenAIKey(keyring, { ...sealed, iv }, binding), CredentialDecryptError);
  await assertRejects(() => decryptOpenAIKey(keyring, { ...sealed, iv: sealed.iv.slice(0, 8) }, binding), CredentialDecryptError);
});

Deno.test("rotation: old versions still decrypt, new writes use the active version", async () => {
  const old = await loadKeyring(`1:${KEY_1}`, 1);
  const sealed = await encryptOpenAIKey(old, API_KEY, binding);
  const rotated = await loadKeyring(`1:${KEY_1},2:${KEY_2}`, 2);
  assertEquals(await decryptOpenAIKey(rotated, sealed, binding), API_KEY);
  assertEquals((await encryptOpenAIKey(rotated, API_KEY, binding)).version, 2);

  const withoutOld = await loadKeyring(`2:${KEY_2}`, 2);
  await assertRejects(() => decryptOpenAIKey(withoutOld, sealed, binding), CredentialDecryptError);
  await assertRejects(() => decryptOpenAIKey(rotated, { ...sealed, version: 2 }, binding), CredentialDecryptError);
});

Deno.test("the keyring rejects malformed keys and an unlisted active version", async () => {
  await assertRejects(() => loadKeyring("1:short", 1));
  await assertRejects(() => loadKeyring(`1:${KEY_1}`, 2));
  const err = await assertRejects(() => loadKeyring(`1:${KEY_1}`, 2));
  assertInstanceOf(err, Error);
  assert(!err.message.includes(KEY_1));
});

Deno.test("bytea hex helpers round-trip and reject other shapes", () => {
  const bytes = new Uint8Array([0, 1, 171, 255]);
  assertEquals(toPgBytea(bytes), "\\x0001abff");
  assertEquals(fromPgBytea("\\x0001abff"), bytes);
  assertEquals(fromPgBytea("0001abff"), null);
  assertEquals(fromPgBytea("\\x0"), null);
  assertEquals(fromPgBytea(42), null);
});
