import { describe, expect, it } from "vitest";
import { historyReturnPath } from "./return-to";

describe("historyReturnPath", () => {
  it("allows the interviews page and workspace pages", () => {
    expect(historyReturnPath("/interviews")).toBe("/interviews");
    expect(historyReturnPath("/workspaces/cccccccc-0000-4000-8000-000000000001")).toBe(
      "/workspaces/cccccccc-0000-4000-8000-000000000001",
    );
  });

  it("falls back to the interviews page for anything else", () => {
    for (const value of [
      null,
      "",
      "https://evil.example/interviews",
      "//evil.example",
      "/workspaces/not-a-uuid",
      "/workspaces/cccccccc-0000-4000-8000-000000000001/extra",
      "/workspaces/cccccccc-0000-4000-8000-000000000001?x=1",
      "/interviews/../login",
    ]) {
      expect(historyReturnPath(value)).toBe("/interviews");
    }
  });
});
