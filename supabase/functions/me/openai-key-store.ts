import { maskOpenAIKey, type OpenAIKeyErrorCode, type OpenAIKeyStatus } from "@stackprep/shared";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CredentialDecryptError, decryptOpenAIKey, encryptOpenAIKey, type Keyring, toPgBytea } from "../_shared/ai/credential-crypto.ts";
import {
  createOpenAICredentialStore,
  type OpenAICredentialStatusRow,
  OpenAIKeyUndecryptableError,
  type ResolvedOpenAIKey,
} from "../_shared/ai/credentials.ts";

export const KEY_ATTEMPT_LIMIT = 5;
export const KEY_ATTEMPT_WINDOW = "10 minutes";

/** Key management for the signed-in user only; every method takes the authenticated user id. */
export interface OpenAIKeyStore {
  getStatus(userId: string): Promise<OpenAICredentialStatusRow | null>;
  /** False when the user has used up save/validate attempts in the window. */
  reserveAttempt(userId: string): Promise<boolean>;
  /** Encrypts and stores a validated key under a new credential id, replacing any previous key. */
  save(userId: string, apiKey: string): Promise<void>;
  /** The stored key whatever its status, for re-validation; null when none is stored. */
  load(userId: string): Promise<ResolvedOpenAIKey | null>;
  markStatus(userId: string, credentialId: string, status: OpenAIKeyStatus, code: OpenAIKeyErrorCode | null): Promise<boolean>;
  delete(userId: string): Promise<boolean>;
}

function check(action: string, error: { message: string } | null): void {
  if (error) {
    throw new Error(`Failed to ${action}: ${error.message}`);
  }
}

export function createOpenAIKeyStore(serviceClient: SupabaseClient, keyring: Keyring): OpenAIKeyStore {
  const credentials = createOpenAICredentialStore(serviceClient);
  return {
    getStatus: (userId) => credentials.getStatus(userId),
    markStatus: (userId, credentialId, status, code) => credentials.markStatus(userId, credentialId, status, code),
    async reserveAttempt(userId) {
      const { data, error } = await serviceClient.rpc("reserve_openai_key_attempt", {
        p_user_id: userId,
        p_max: KEY_ATTEMPT_LIMIT,
        p_window: KEY_ATTEMPT_WINDOW,
      });
      check("reserve OpenAI key attempt", error);
      return data === true;
    },
    async save(userId, apiKey) {
      const credentialId = crypto.randomUUID();
      const sealed = await encryptOpenAIKey(keyring, apiKey, { userId, credentialId });
      const { error } = await serviceClient.rpc("upsert_openai_credential", {
        p_user_id: userId,
        p_credential_id: credentialId,
        p_ciphertext: toPgBytea(sealed.ciphertext),
        p_iv: toPgBytea(sealed.iv),
        p_enc_key_version: sealed.version,
        p_key_hint: maskOpenAIKey(apiKey),
      });
      check("save OpenAI key", error);
    },
    async load(userId) {
      const stored = await credentials.load(userId);
      if (!stored) {
        return null;
      }
      try {
        const apiKey = await decryptOpenAIKey(keyring, stored, { userId, credentialId: stored.credentialId });
        return { apiKey, credentialId: stored.credentialId };
      } catch (err) {
        throw err instanceof CredentialDecryptError ? new OpenAIKeyUndecryptableError() : err;
      }
    },
    async delete(userId) {
      const { data, error } = await serviceClient.rpc("delete_openai_credential", { p_user_id: userId });
      check("delete OpenAI key", error);
      return data === true;
    },
  };
}
