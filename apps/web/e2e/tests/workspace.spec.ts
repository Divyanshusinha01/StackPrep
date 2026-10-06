import { expect, test } from "../support/fixtures";

test("a ready workspace is listed and can start an interview", async ({ page, workspace }) => {
  await page.goto("/workspaces");
  const row = page.getByTestId("workspace-list").getByRole("listitem").filter({ hasText: workspace.repositoryFullName });
  await expect(row).toContainText("Ready");

  await row.getByRole("link", { name: workspace.repositoryFullName }).click();
  await expect(page).toHaveURL(new RegExp(`/workspaces/${workspace.workspaceId}$`));
  await expect(page.getByRole("heading", { level: 1, name: workspace.repositoryFullName })).toBeVisible();
  await expect(page.getByText("Ready", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start Interview" })).toBeEnabled();
  await expect(page.getByText("No interviews yet.")).toBeVisible();
});
