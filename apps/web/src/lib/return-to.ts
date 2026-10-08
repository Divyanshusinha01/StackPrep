const WORKSPACE_PATH = /^\/workspaces\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The history page to return to after deleting an interview; anything else falls back to `/interviews`. */
export function historyReturnPath(value: unknown): string {
  if (typeof value === "string" && (value === "/interviews" || WORKSPACE_PATH.test(value))) {
    return value;
  }
  return "/interviews";
}
