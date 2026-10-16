import type { OpenAIKeyErrorCode, OpenAIKeyStatus } from "@stackprep/shared";
import type { SupabaseClient } from "@supabase/supabase-js";
import { RealtimeUnavailableError } from "../realtime/openai-realtime.ts";
import { CredentialDecryptError, decryptOpenAIKey, fromPgBytea, type Keyring } from "./credential-crypto.ts";
import { AIAuthError, AIPermissionError, AIQuotaError } from "./provider.ts";

/** A stored row as the resolver needs it; ciphertext never leaves this module undecrypted. */
export interface StoredOpenAICredential {
  credentialId: string;
  ciphertext: Uint8Array;
  iv: Uint8Array;
  version: number;
  status: OpenAIKeyStatus;
}

/** Status columns only (`openai_credential_status`), for gates and the settings page. */
export interface OpenAICredentialStatusRow {
  status: OpenAIKeyStatus;
  key_hint: string;
  validated_at: string | null;
  last_error_code: OpenAIKeyErrorCode | null;
}

export type UnusableKeyStatus = Exclude<OpenAIKeyStatus, "valid">;

/** Service-role access to `openai_credentials`. Every call is keyed by a user id the caller trusts. */
export interface OpenAICredentialStore {
  load(userId: string): Promise<StoredOpenAICredential | null>;
  getStatus(userId: string): Promise<OpenAICredentialStatusRow | null>;
  /** Compare-and-set on `credentialId`; false when the key was replaced or deleted since. */
  markStatus(userId: string, credentialId: string, status: OpenAIKeyStatus, code: OpenAIKeyErrorCode | null): Promise<boolean>;
}

/** Base class for every reason the owner's key cannot be used. Carries no key material. */
export class OpenAIKeyError extends Error {
  override name = "OpenAIKeyError";
}

export class OpenAIKeyMissingError extends OpenAIKeyError {
  override name = "OpenAIKeyMissingError";

  constructor() {
    super("No OpenAI key is configured");
  }
}

export class OpenAIKeyUnusableError extends OpenAIKeyError {
  override name = "OpenAIKeyUnusableError";

  constructor(readonly status: UnusableKeyStatus) {
    super(`The OpenAI key is ${status}`);
  }
}

/** The stored key could not be decrypted (master key misconfigured or data tampered). Fails closed. */
export class OpenAIKeyUndecryptableError extends OpenAIKeyError {
  override name = "OpenAIKeyUndecryptableError";

  constructor() {
    super("The stored OpenAI key could not be decrypted");
  }
}

export interface ResolvedOpenAIKey {
  apiKey: string;
  credentialId: string;
}

export interface OpenAICredentialResolver {
  /** Decrypts the owner's key on every call (no cache), so replacement and deletion apply immediately. */
  resolve(userId: string): Promise<ResolvedOpenAIKey>;
  markStatus(userId: string, credentialId: string, status: OpenAIKeyStatus, code: OpenAIKeyErrorCode | null): Promise<boolean>;
}

export interface KeyFailure {
  status: UnusableKeyStatus;
  code: OpenAIKeyErrorCode;
}

/** The key status a provider failure implies, or null when the failure says nothing about the key. */
export function keyFailureOf(err: unknown): KeyFailure | null {
  if (err instanceof AIAuthError) {
    return { status: "invalid", code: "invalid_api_key" };
  }
  if (err instanceof AIQuotaError) {
    return { status: "quota_exhausted", code: "insufficient_quota" };
  }
  if (err instanceof AIPermissionError) {
    return { status: "permission_denied", code: err.reason };
  }
  if (err instanceof RealtimeUnavailableError) {
    switch (err.failure) {
      case "auth":
        return { status: "invalid", code: "invalid_api_key" };
      case "quota":
        return { status: "quota_exhausted", code: "insufficient_quota" };
      case "permission":
        return { status: "permission_denied", code: "permission_denied" };
      case "model_unavailable":
        return { status: "permission_denied", code: "model_unavailable" };
    }
  }
  return null;
}

/** The unusable status behind a key error or provider failure, or null when it is neither. */
export function unusableStatusOf(err: unknown): UnusableKeyStatus | "missing" | null {
  if (err instanceof OpenAIKeyMissingError) {
    return "missing";
  }
  if (err instanceof OpenAIKeyUnusableError) {
    return err.status;
  }
  if (err instanceof OpenAIKeyUndecryptableError) {
    return "invalid";
  }
  return keyFailureOf(err)?.status ?? null;
}

function check(action: string, error: { message: string } | null): void {
  if (error) {
    throw new Error(`Failed to ${action}: ${error.message}`);
  }
}

export function createOpenAICredentialStore(serviceClient: SupabaseClient): OpenAICredentialStore {
  return {
    async load(userId) {
      const { data, error } = await serviceClient
        .from("openai_credentials")
        .select("credential_id, ciphertext, iv, enc_key_version, status")
        .eq("user_id", userId)
        .maybeSingle();
      check("load OpenAI credential", error);
      if (!data) {
        return null;
      }
      const ciphertext = fromPgBytea(data.ciphertext);
      const iv = fromPgBytea(data.iv);
      if (!ciphertext || !iv) {
        throw new OpenAIKeyUndecryptableError();
      }
      return {
        credentialId: data.credential_id as string,
        ciphertext,
        iv,
        version: Number(data.enc_key_version),
        status: data.status as OpenAIKeyStatus,
      };
    },
    async getStatus(userId) {
      const { data, error } = await serviceClient.rpc("openai_credential_status", { p_user_id: userId });
      check("load OpenAI key status", error);
      const row = (Array.isArray(data) ? data[0] : data) as OpenAICredentialStatusRow | undefined;
      return row ?? null;
    },
    async markStatus(userId, credentialId, status, code) {
      const { data, error } = await serviceClient.rpc("mark_openai_credential_status", {
        p_user_id: userId,
        p_credential_id: credentialId,
        p_status: status,
        p_error_code: code,
      });
      check("mark OpenAI key status", error);
      return data === true;
    },
  };
}

export function createOpenAICredentialResolver(store: OpenAICredentialStore, keyring: Keyring): OpenAICredentialResolver {
  return {
    async resolve(userId) {
      const stored = await store.load(userId);
      if (!stored) {
        throw new OpenAIKeyMissingError();
      }
      if (stored.status !== "valid") {
        throw new OpenAIKeyUnusableError(stored.status);
      }
      try {
        const apiKey = await decryptOpenAIKey(keyring, stored, { userId, credentialId: stored.credentialId });
        return { apiKey, credentialId: stored.credentialId };
      } catch (err) {
        if (err instanceof CredentialDecryptError) {
          throw new OpenAIKeyUndecryptableError();
        }
        throw err;
      }
    },
    markStatus: (userId, credentialId, status, code) => store.markStatus(userId, credentialId, status, code),
  };
}
