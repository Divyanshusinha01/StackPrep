import { expect, test } from "../support/fixtures";

test.describe("without an OpenAI key", () => {
  test.use({ openAIKeyStatus: null });

  test("the workspace cannot start an interview and links to Settings and back", async ({ page, workspace }) => {
    await page.goto(`/workspaces/${workspace.workspaceId}`);
    await expect(page.getByTestId("openai-key-notice")).toHaveText("Add your OpenAI API key in Settings to use AI features.");
    await expect(page.getByRole("button", { name: "Start Interview" })).toBeDisabled();

    await page.getByRole("link", { name: "Add key" }).click();
    await expect(page).toHaveURL(`/settings?return_to=${encodeURIComponent(`/workspaces/${workspace.workspaceId}`)}`);
    await expect(page.getByTestId("openai-key-missing")).toBeVisible();
    await expect(page.getByRole("link", { name: "Continue" })).toHaveCount(0);
  });

  test("the masked key field rejects a value that is not an OpenAI secret key", async ({ page, admin, user }) => {
    await page.goto("/settings");
    const input = page.getByTestId("openai-key-input");
    await expect(input).toHaveAttribute("type", "password");
    await expect(input).toHaveAttribute("autocomplete", "off");
    await expect(input).toHaveValue("");

    await input.fill("not-a-key-at-all");
    await page.getByRole("button", { name: "Validate and save" }).click();

    await expect(page).toHaveURL(/\/settings\?error=invalid_request$/);
    await expect(page.getByText("That does not look like an OpenAI secret key.", { exact: false })).toBeVisible();
    await expect(page.getByTestId("openai-key-missing")).toBeVisible();
    expect(page.url()).not.toContain("not-a-key");
    const { count } = await admin.from("openai_credentials").select("user_id", { count: "exact", head: true }).eq("user_id", user.id);
    expect(count).toBe(0);
  });

  test("existing workspaces stay browsable and the account menu flags the key", async ({ page, workspace }) => {
    await page.goto("/workspaces");
    await expect(page).toHaveURL("/workspaces");
    await expect(page.getByTestId("workspace-list")).toContainText(workspace.repositoryFullName.split("/")[1]);
    await expect(page.getByTestId("openai-key-alert")).toBeVisible();
  });
});

test.describe("first run without an OpenAI key", () => {
  test.use({ openAIKeyStatus: null });

  test("the key step comes before connecting GitHub or picking a repository", async ({ page, user }) => {
    expect(user.id).toBeTruthy();
    const keyStep = `/settings?return_to=${encodeURIComponent("/workspaces/new")}&onboarding=1`;

    await page.goto("/workspaces");
    await expect(page).toHaveURL(keyStep);
    await expect(page.getByRole("heading", { level: 1, name: "Add your OpenAI API key" })).toBeVisible();
    await expect(page.getByTestId("setup-checklist").locator('[aria-current="step"]')).toContainText(
      "Add your OpenAI API key",
    );
    await expect(page.getByRole("button", { name: "Validate and continue" })).toBeVisible();

    await page.goto("/workspaces/new");
    await expect(page).toHaveURL(keyStep);
  });
});

test.describe("with a working key", () => {
  test("Settings shows only the hint, and deleting the key turns AI features off", async ({ page, admin, user, workspace }) => {
    const { data } = await admin.from("openai_credentials").select("key_hint").eq("user_id", user.id).single();
    const hint = data?.key_hint ?? "";
    expect(hint).toMatch(/^sk-\.\.\./);

    await page.goto(`/settings?return_to=${encodeURIComponent(`/workspaces/${workspace.workspaceId}`)}`);
    const status = page.getByTestId("openai-key-status");
    await expect(status).toContainText(hint);
    await expect(page.getByTestId("openai-key-state")).toHaveText("Working");
    expect(await page.content()).not.toMatch(/sk-e2e-[0-9a-f]{8,}/);
    await expect(page.getByRole("link", { name: "Continue" })).toHaveAttribute("href", `/workspaces/${workspace.workspaceId}`);

    await page.getByRole("button", { name: "Delete key" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete key" }).click();
    await expect(page.getByText("Key deleted. AI features are off until you add a key.")).toBeVisible();
    await expect(page.getByTestId("openai-key-missing")).toBeVisible();
    const { count } = await admin.from("openai_credentials").select("user_id", { count: "exact", head: true }).eq("user_id", user.id);
    expect(count).toBe(0);

    await page.goto(`/workspaces/${workspace.workspaceId}`);
    await expect(page.getByTestId("openai-key-notice")).toBeVisible();
    await expect(page.getByRole("button", { name: "Start Interview" })).toBeDisabled();
  });

  test("dismissing the delete confirmation keeps the key", async ({ page, admin, user }) => {
    await page.goto("/settings");
    await page.getByRole("button", { name: "Delete key" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("alertdialog")).toBeHidden();
    await expect(page.getByTestId("openai-key-state")).toHaveText("Working");
    await expect(page).toHaveURL("/settings");
    const { data } = await admin.from("openai_credentials").select("status").eq("user_id", user.id).single();
    expect(data?.status).toBe("valid");
  });
});

test.describe("with a key OpenAI rejected", () => {
  test.use({ openAIKeyStatus: "invalid" });

  test("Settings and the workspace both say the key must be replaced", async ({ page, workspace }) => {
    await page.goto("/settings");
    await expect(page.getByTestId("openai-key-state")).toHaveText("Rejected by OpenAI");
    await expect(page.getByText("Replace key")).toBeVisible();

    await page.goto(`/workspaces/${workspace.workspaceId}`);
    await expect(page.getByTestId("openai-key-notice")).toHaveText("Your OpenAI API key was rejected or revoked. Replace it in Settings.");
    await expect(page.getByRole("button", { name: "Start Interview" })).toBeDisabled();
  });
});

test.describe("with an account out of quota", () => {
  test.use({ openAIKeyStatus: "quota_exhausted" });

  test("the workspace points to OpenAI billing instead of a new key", async ({ page, workspace }) => {
    await page.goto(`/workspaces/${workspace.workspaceId}`);
    await expect(page.getByTestId("openai-key-notice")).toContainText("no remaining quota");
    await expect(page.getByRole("button", { name: "Start Interview" })).toBeDisabled();

    await page.goto("/settings");
    await expect(page.getByTestId("openai-key-state")).toHaveText("Out of quota");
    await expect(page.getByRole("link", { name: "OpenAI billing" })).toHaveAttribute("href", /platform\.openai\.com/);
  });
});
