import { describe, expect, it } from "vitest";
import { isProtectedPath, safeNextPath } from "./auth.ts";

describe("isProtectedPath", () => {
  it.each(["/workspaces", "/workspaces/abc", "/interviews", "/interviews/abc/report", "/github/callback"])(
    "protects %s",
    (path) => {
      expect(isProtectedPath(path)).toBe(true);
    },
  );

  it.each(["/", "/login", "/status", "/auth/callback", "/workspacesx", "/interviewsfoo", "/githubx"])("does not protect %s", (path) => {
    expect(isProtectedPath(path)).toBe(false);
  });
});

describe("safeNextPath", () => {
  it("keeps same-origin relative paths", () => {
    expect(safeNextPath("/interviews/123?tab=report#q2")).toBe("/interviews/123?tab=report#q2");
  });

  it.each([
    null,
    undefined,
    "",
    "workspaces",
    "//evil.example",
    "/\\evil.example",
    "https://evil.example/workspaces",
    "javascript:alert(1)",
  ])("falls back for %s", (next) => {
    expect(safeNextPath(next)).toBe("/workspaces");
  });

  it("keeps the GitHub setup callback query so it survives sign-in", () => {
    const next = "/github/callback?code=abc&installation_id=12345&setup_action=install";
    expect(safeNextPath(next)).toBe(next);
  });

  it("uses a custom fallback", () => {
    expect(safeNextPath("//evil.example", "/")).toBe("/");
  });
});
