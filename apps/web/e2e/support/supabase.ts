import type { BrowserContext } from "@playwright/test";
import type { Database } from "@stackprep/shared";
import { createServerClient } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { loadE2EEnv } from "./env";

export type AdminClient = SupabaseClient<Database>;

/** Service-role client for seeding and assertions. Bypasses RLS; never used from the browser. */
export function createAdminClient(): AdminClient {
  const env = loadE2EEnv();
  return createClient<Database>(env.supabaseUrl, env.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export interface SessionCookie {
  name: string;
  value: string;
}

/**
 * Signs in with email and password through `@supabase/ssr`, so the cookies have exactly the
 * chunked format `proxy.ts` and the server client read. A test-only path: production sign-in is
 * GitHub OAuth, which cannot run unattended.
 */
export async function signInCookies(email: string, password: string): Promise<SessionCookie[]> {
  const env = loadE2EEnv();
  const jar = new Map<string, string>();
  const client = createServerClient(env.supabaseUrl, env.anonKey, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (cookies) => {
        for (const { name, value } of cookies) {
          if (value) {
            jar.set(name, value);
          } else {
            jar.delete(name);
          }
        }
      },
    },
  });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) {
    throw new Error(`E2E: sign-in failed for ${email}: ${error.message}`);
  }
  if (jar.size === 0) {
    throw new Error("E2E: sign-in succeeded but no session cookies were written.");
  }
  return [...jar].map(([name, value]) => ({ name, value }));
}

/** Replaces the context's cookies with a fresh session for `email`. */
export async function signInContext(context: BrowserContext, email: string, password: string): Promise<void> {
  const env = loadE2EEnv();
  const cookies = await signInCookies(email, password);
  await context.clearCookies();
  await context.addCookies(
    cookies.map(({ name, value }) => ({ name, value, url: env.baseUrl, sameSite: "Lax" as const })),
  );
}
