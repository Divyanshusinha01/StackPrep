import { SHARE_TOKEN_LENGTH } from "@stackprep/shared";

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll(
    "=",
    "",
  );
}

/** 256 bits from the platform CSPRNG, as a 43-character base64url token. */
export function generateShareToken(): string {
  const token = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  if (token.length !== SHARE_TOKEN_LENGTH) {
    throw new Error("Unexpected share token length");
  }
  return token;
}

/** Lowercase hex SHA-256. Only this is stored, so the database cannot reveal a working link. */
export async function hashShareToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
