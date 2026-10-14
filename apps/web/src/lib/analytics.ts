import { track as vercelTrack } from "@vercel/analytics";

export type CtaLocation = "hero" | "site-header" | "mobile-menu" | "final-cta";

/**
 * Product events. Properties must never carry repository names, file paths, transcript text or
 * user identifiers: the privacy policy promises aggregate, content-free analytics.
 */
export interface AnalyticsEvents {
  cta_click: { location: CtaLocation; signed_in: boolean };
  login_started: Record<string, never>;
  workspace_created: Record<string, never>;
  interview_started: { resumed: boolean };
  report_viewed: Record<string, never>;
}

/** Browser-side event. A no-op outside Vercel, and never throws into the UI. */
export function track<E extends keyof AnalyticsEvents>(event: E, properties: AnalyticsEvents[E]): void {
  try {
    vercelTrack(event, properties);
  } catch {
    // Analytics must never break a user action.
  }
}
