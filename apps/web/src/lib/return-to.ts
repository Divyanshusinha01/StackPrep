const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const WORKSPACE_PATH = new RegExp(`^/workspaces/${UUID}$`, "i");
const SETTINGS_RETURN_PATH = new RegExp(`^/(?:workspaces(?:/new|/${UUID})?|interviews/${UUID}(?:/report)?)$`, "i");

/** The history page to return to after deleting an interview; anything else falls back to `/interviews`. */
export function historyReturnPath(value: unknown): string {
  if (typeof value === "string" && (value === "/interviews" || WORKSPACE_PATH.test(value))) {
    return value;
  }
  return "/interviews";
}

/** Where to go back to after setting up the OpenAI key; only app pages that gate on it, else null. */
export function settingsReturnPath(value: unknown): string | null {
  return typeof value === "string" && SETTINGS_RETURN_PATH.test(value) ? value : null;
}

/** The settings page, returning to `returnTo` once a key is saved. */
export function openAIKeySetupHref(returnTo?: string): string {
  const path = settingsReturnPath(returnTo);
  return path ? `/settings?${new URLSearchParams({ return_to: path })}` : "/settings";
}

/** The settings page as the key step of first-run setup; saving a key continues straight to `returnTo`. */
export function onboardingSetupHref(returnTo: string): string {
  const query = new URLSearchParams();
  const path = settingsReturnPath(returnTo);
  if (path) {
    query.set("return_to", path);
  }
  query.set("onboarding", "1");
  return `/settings?${query}`;
}
