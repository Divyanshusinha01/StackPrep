import { randomBytes } from "node:crypto";

export const SESSION_TTL_MS = 30 * 60 * 1000;

export interface Session {
  token: string;
  userId: string;
  expiresAt: number;
}

/** Keeps sessions in process memory, keyed by token. */
export class SessionStore {
  private readonly sessions = new Map<string, Session>();

  save(session: Session): void {
    this.sessions.set(session.token, session);
  }

  find(token: string): Session | undefined {
    return this.sessions.get(token);
  }

  revoke(token: string): void {
    this.sessions.delete(token);
  }
}

export function createSession(store: SessionStore, userId: string, now = Date.now()): Session {
  const session = { token: randomBytes(32).toString("hex"), userId, expiresAt: now + SESSION_TTL_MS };
  store.save(session);
  return session;
}

/** Returns the user id behind a session token, or null when the token is unknown. */
export function verifySession(store: SessionStore, token: string): string | null {
  const session = store.find(token);
  if (!session) {
    return null;
  }
  return session.userId;
}

export function logout(store: SessionStore, token: string): void {
  store.revoke(token);
}
