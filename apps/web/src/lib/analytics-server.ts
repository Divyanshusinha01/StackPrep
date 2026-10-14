import "server-only";
import { track as vercelTrack } from "@vercel/analytics/server";
import type { AnalyticsEvents } from "@/lib/analytics";

/** Server-side event for server actions. Never throws, so it cannot fail the action it reports on. */
export async function trackServer<E extends keyof AnalyticsEvents>(
  event: E,
  properties: AnalyticsEvents[E],
): Promise<void> {
  try {
    await vercelTrack(event, properties);
  } catch {
    // Analytics must never break a user action.
  }
}
