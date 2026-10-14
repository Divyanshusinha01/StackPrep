import { expect, type Page } from "@playwright/test";

/** Runs the lobby's camera and microphone check on Chromium's fake devices. */
export async function passDeviceCheck(page: Page): Promise<void> {
  const checks = page.getByRole("region", { name: "Camera and microphone check" });
  const disclosure = checks.getByTestId("media-disclosure");
  await expect(disclosure).toContainText("Frames are discarded");
  await expect(disclosure).toContainText("not retained");
  await expect(disclosure.getByRole("link", { name: "Privacy Policy" })).toHaveAttribute("href", "/privacy");
  await page.getByRole("button", { name: "Start check" }).click();
  await expect(checks.getByRole("listitem").filter({ hasText: "Camera" })).toContainText("(passed)");
  await expect(checks.getByRole("listitem").filter({ hasText: "Microphone" })).toContainText("(passed)");
}
