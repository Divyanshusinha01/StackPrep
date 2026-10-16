import { describe, expect, it } from "vitest";
import { historyReturnPath, onboardingSetupHref, openAIKeySetupHref, settingsReturnPath } from "./return-to";

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

describe("settingsReturnPath", () => {
  const id = "cccccccc-0000-4000-8000-000000000001";

  it("allows the pages that gate on the OpenAI key", () => {
    for (const path of ["/workspaces", "/workspaces/new", `/workspaces/${id}`, `/interviews/${id}`, `/interviews/${id}/report`]) {
      expect(settingsReturnPath(path)).toBe(path);
    }
  });

  it("rejects everything else", () => {
    for (const value of [null, "", "/settings", "//evil.example", "https://evil.example/workspaces", `/interviews/${id}/x`, "/interviews"]) {
      expect(settingsReturnPath(value)).toBeNull();
    }
  });

  it("builds the settings link with an encoded return path", () => {
    expect(openAIKeySetupHref(`/interviews/${id}/report`)).toBe(`/settings?return_to=%2Finterviews%2F${id}%2Freport`);
    expect(openAIKeySetupHref("https://evil.example")).toBe("/settings");
    expect(openAIKeySetupHref()).toBe("/settings");
  });

  it("builds the first-run key step, dropping unsafe return paths", () => {
    expect(onboardingSetupHref("/workspaces/new")).toBe("/settings?return_to=%2Fworkspaces%2Fnew&onboarding=1");
    expect(onboardingSetupHref("https://evil.example")).toBe("/settings?onboarding=1");
  });
});
