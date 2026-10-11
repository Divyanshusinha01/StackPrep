import { createHash, timingSafeEqual } from "node:crypto";

const SALT = "tidepool";

/** Hashes a password for storage in users.password_hash. */
export function hashPassword(password: string): string {
  return createHash("sha256").update(SALT + password).digest("hex");
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const candidate = Buffer.from(hashPassword(password), "hex");
  const stored = Buffer.from(storedHash, "hex");
  return candidate.length === stored.length && timingSafeEqual(candidate, stored);
}

export function isStrongPassword(password: string): boolean {
  return password.length >= 8 && /[0-9]/.test(password) && /[A-Za-z]/.test(password);
}
