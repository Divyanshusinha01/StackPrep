import "server-only";
import { type AdminMetricsResponse, adminMetricsResponseSchema, type AdminWindowDays, isAdminUserId } from "@stackprep/shared";
import type { User } from "@supabase/supabase-js";
import { notFound } from "next/navigation";
import { adminEnv } from "@/env";
import { getUser } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/** The user only if Supabase Auth verified them and their id is allowlisted; emails are never compared. */
export function authorizeAdmin(user: User | null, adminUserIds: ReadonlySet<string>): User | null {
  return user && isAdminUserId(adminUserIds, user.id) ? user : null;
}

/**
 * Gate for every admin page and read. Unauthenticated and non-admin callers both get a 404, so the
 * route's existence is not revealed. `getUser()` validates the session with Supabase Auth.
 */
export async function requireAdmin(): Promise<User> {
  const admin = authorizeAdmin(await getUser(), adminEnv.ADMIN_USER_IDS);
  if (!admin) {
    notFound();
  }
  return admin;
}

/**
 * Reads the dashboard aggregates from the `admin` Edge Function with the admin's own session. The
 * function re-checks the allowlist and holds the only service-role credential; this app has none.
 * Null when the backend refuses or fails.
 */
export async function getAdminMetrics(days: AdminWindowDays): Promise<AdminMetricsResponse | null> {
  await requireAdmin();
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.functions.invoke(`admin/metrics?days=${days}`, { method: "GET" });
  if (error) {
    return null;
  }
  const parsed = adminMetricsResponseSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}
