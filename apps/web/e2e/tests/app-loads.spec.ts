import { expect, test } from "../support/fixtures";

test.describe("signed out", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("landing page renders the hero and sign-in CTA without console errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") {
        errors.push(message.text());
      }
    });
    page.on("pageerror", (error) => errors.push(error.message));

    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: /Defend the repo/ })).toBeVisible();
    await expect(page.getByRole("link", { name: "Sign in with GitHub" }).first()).toHaveAttribute("href", "/login");
    expect(errors).toEqual([]);
  });

  test("landing page explains the bring-your-own-key model and setup order", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("Bring your own OpenAI API key.", { exact: false }).first()).toBeVisible();
    const steps = page.getByRole("list", { name: "How it starts" }).getByRole("listitem");
    await expect(steps).toHaveText([/Sign in with GitHub/, /Add your OpenAI API key/, /Connect a repository/]);

    const section = page.locator("#your-key");
    await section.scrollIntoViewIfNeeded();
    await expect(section.getByRole("heading", { level: 2, name: "Your key. Your usage." })).toBeVisible();
    await expect(section).toContainText("You pay OpenAI directly");
    await expect(section).not.toContainText(/free/i);
    await expect(
      page.getByRole("navigation", { name: "Sections", exact: true }).getByRole("listitem"),
    ).toHaveCount(6);
  });

  test("status page reports the API as healthy", async ({ page }) => {
    await page.goto("/status");
    await expect(page.getByTestId("api-status")).toContainText("ok");
  });

  test("protected pages redirect to login with the return path", async ({ page }) => {
    await page.goto("/workspaces");
    await expect(page).toHaveURL(/\/login\?next=%2Fworkspaces$/);
    await expect(page.getByRole("button", { name: "Sign in with GitHub" })).toBeVisible();
  });
});

test.describe("signed in", () => {
  test("landing CTA opens the workspace list", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Open workspaces" }).first().click();
    await expect(page).toHaveURL(/\/workspaces$/);
    await expect(page.getByRole("heading", { level: 1, name: "Workspaces" })).toBeVisible();
    await expect(page.getByText("Connect GitHub and choose a repository to start a workspace.")).toBeVisible();
  });
});
