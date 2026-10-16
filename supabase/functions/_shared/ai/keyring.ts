import { parseEncryptionKeyring } from "@stackprep/shared";
import { importKeyring, type Keyring } from "./credential-crypto.ts";

/** `rawKeys` is `version:base64` pairs (OPENAI_KEY_ENCRYPTION_KEYS); the active version must be listed. */
export async function loadKeyring(rawKeys: string, activeVersion: number): Promise<Keyring> {
  const parsed = parseEncryptionKeyring(rawKeys);
  if (!parsed) {
    throw new Error("OPENAI_KEY_ENCRYPTION_KEYS is not a valid keyring");
  }
  return await importKeyring(parsed, activeVersion);
}
