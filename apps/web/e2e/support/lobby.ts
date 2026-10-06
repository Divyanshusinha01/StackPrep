import { expect, type Page } from "@playwright/test";

/** Runs the lobby's camera and microphone check on Chromium's fake devices. */
export async function passDeviceCheck(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Start check" }).click();
  const checks = page.getByRole("region", { name: "Camera and microphone check" });
  await expect(checks.getByRole("listitem").filter({ hasText: "Camera" })).toContainText("(passed)");
  await expect(checks.getByRole("listitem").filter({ hasText: "Microphone" })).toContainText("(passed)");
}
