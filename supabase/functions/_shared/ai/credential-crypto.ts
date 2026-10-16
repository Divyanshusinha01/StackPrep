// AES-256-GCM encryption of users' OpenAI keys with WebCrypto. No imports and no database access,
// so the E2E seed (Node) can reuse it with a test-only keyring. Parsing the env value lives in keyring.ts.

const IV_BYTES = 12;

/** Versioned master keys; new ciphertext always uses `activeVersion`. */
export interface Keyring {
  activeVersion: number;
  keys: ReadonlyMap<number, CryptoKey>;
}

/** Binds a ciphertext to its row: copied to another user or credential, it fails to decrypt. */
export interface CredentialBinding {
  userId: string;
  credentialId: string;
}

export interface SealedCredential {
  ciphertext: Uint8Array;
  iv: Uint8Array;
  version: number;
}

/** Decryption failed: unknown key version, wrong binding, or tampered data. Carries no detail. */
export class CredentialDecryptError extends Error {
  override name = "CredentialDecryptError";

  constructor() {
    super("Stored OpenAI key could not be decrypted");
  }
}

function base64Bytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function credentialAad({ userId, credentialId }: CredentialBinding): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`stackprep:openai-key:v1:${userId}:${credentialId}`);
}

/** `parsed` maps each version to its base64 32-byte key; the active version must be listed. */
export async function importKeyring(parsed: ReadonlyMap<number, string>, activeVersion: number): Promise<Keyring> {
  if (!parsed.has(activeVersion)) {
    throw new Error("OPENAI_KEY_ENCRYPTION_ACTIVE_VERSION is not listed in OPENAI_KEY_ENCRYPTION_KEYS");
  }
  const keys = new Map<number, CryptoKey>();
  for (const [version, raw] of parsed) {
    keys.set(version, await crypto.subtle.importKey("raw", base64Bytes(raw), "AES-GCM", false, ["encrypt", "decrypt"]));
  }
  return { activeVersion, keys };
}

export async function encryptOpenAIKey(keyring: Keyring, apiKey: string, binding: CredentialBinding): Promise<SealedCredential> {
  const key = keyring.keys.get(keyring.activeVersion);
  if (!key) {
    throw new Error("The active encryption key is missing");
  }
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: credentialAad(binding) },
    key,
    new TextEncoder().encode(apiKey),
  );
  return { ciphertext: new Uint8Array(ciphertext), iv, version: keyring.activeVersion };
}

/** Throws CredentialDecryptError on any failure; never returns a partial or unauthenticated value. */
export async function decryptOpenAIKey(keyring: Keyring, sealed: SealedCredential, binding: CredentialBinding): Promise<string> {
  const key = keyring.keys.get(sealed.version);
  if (!key || sealed.iv.length !== IV_BYTES) {
    throw new CredentialDecryptError();
  }
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: Uint8Array.from(sealed.iv), additionalData: credentialAad(binding) },
      key,
      Uint8Array.from(sealed.ciphertext),
    );
    return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
  } catch {
    throw new CredentialDecryptError();
  }
}

/** PostgREST `bytea` input: `\x` followed by hex. */
export function toPgBytea(bytes: Uint8Array): string {
  return `\\x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** PostgREST `bytea` output; null for anything that is not `\x` hex. */
export function fromPgBytea(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || !/^\\x(?:[0-9a-fA-F]{2})*$/.test(value)) {
    return null;
  }
  const hex = value.slice(2);
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
