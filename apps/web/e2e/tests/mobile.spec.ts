import { expect, test } from "../support/fixtures";

test.use({ storageState: { cookies: [], origins: [] }, hasTouch: true, isMobile: true });

for (const width of [360, 390]) {
  test.describe(`at ${width}px`, () => {
    test.use({ viewport: { width, height: 800 } });

    test("header fits, the CTA is a comfortable tap target and the menu reaches every section", async ({ page }) => {
      await page.goto("/");
      const header = page.getByRole("banner");
      const cta = header.getByRole("link", { name: "Sign in with GitHub" });
      await expect(cta).toBeVisible();
      expect((await cta.boundingBox())?.height).toBeGreaterThanOrEqual(40);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);

      const menuButton = header.getByRole("button", { name: "Open menu" });
      expect((await menuButton.boundingBox())?.height).toBeGreaterThanOrEqual(40);
      await menuButton.click();
      const menu = page.getByRole("dialog");
      await expect(menu).toBeVisible();
      for (const label of ["Connect", "Analyze", "Interview", "Depth", "Report"]) {
        await expect(menu.getByRole("link", { name: label })).toBeVisible();
      }
      await expect(menu.getByRole("link", { name: "Sign in with GitHub" })).toHaveAttribute("href", "/login");

      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
      await expect(menuButton).toBeFocused();

      await menuButton.click();
      await page.getByRole("dialog").getByRole("link", { name: "Report" }).click();
      await expect(page.getByRole("dialog")).toBeHidden();
      await expect(page).toHaveURL(/#report$/);
      await expect(page.locator("#report-heading")).toBeInViewport();
    });
  });
}

test.describe("at 768px", () => {
  test.use({ viewport: { width: 768, height: 1024 } });

  test("shows the inline section nav instead of the menu button", async ({ page }) => {
    await page.goto("/");
    const header = page.getByRole("banner");
    await expect(header.getByRole("navigation", { name: "Sections" })).toBeVisible();
    await expect(header.getByRole("button", { name: "Open menu" })).toBeHidden();
  });
});
