import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import type { EdgeSupabaseEnv } from "@stackprep/shared";

export interface AuthContext {
  user: User;
  /** Acts as the caller, so every query is subject to RLS. */
  supabase: SupabaseClient;
}

export type Authenticate = (req: Request) => Promise<AuthContext | null>;

export interface AuthenticatorDeps {
  verifyToken(token: string): Promise<User | null>;
  userClient(token: string): SupabaseClient;
}

export function bearerToken(req: Request): string | null {
  const header = req.headers.get("Authorization");
  const match = header?.match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : null;
}

/**
 * Verifies the caller's JWT with Supabase Auth. Runs in addition to the gateway's `verify_jwt`,
 * which also accepts the anon key and so does not by itself prove a signed-in user.
 */
export function createAuthenticator({ verifyToken, userClient }: AuthenticatorDeps): Authenticate {
  return async (req) => {
    const token = bearerToken(req);
    if (!token) {
      return null;
    }
    const user = await verifyToken(token);
    if (!user || user.is_anonymous) {
      return null;
    }
    return { user, supabase: userClient(token) };
  };
}

export function createSupabaseAuthenticator(
  env: Pick<EdgeSupabaseEnv, "SUPABASE_URL" | "SUPABASE_ANON_KEY">,
): Authenticate {
  const clientOptions = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
  const authClient = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, clientOptions);

  return createAuthenticator({
    async verifyToken(token) {
      const { data, error } = await authClient.auth.getUser(token);
      return error ? null : data.user;
    },
    userClient(token) {
      return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
        ...clientOptions,
        global: { headers: { Authorization: `Bearer ${token}` } },
      });
    },
  });
}
