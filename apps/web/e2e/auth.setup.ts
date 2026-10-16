import { expect, test as setup } from "@playwright/test";
import { AUTH_FILE, loadE2EEnv } from "./support/env";
import { ensureUser, seedOpenAIKey } from "./support/seed";
import { createAdminClient, signInContext } from "./support/supabase";

/**
 * Signs in the shared E2E user once and saves the session as the default storage state. Specs
 * that seed data use the per-test `user` fixture instead, so their rows never collide.
 */
setup("sign in the shared E2E user", async ({ page }) => {
  const env = loadE2EEnv();
  const admin = createAdminClient();
  const id = await ensureUser(admin, env.userEmail, env.userPassword);
  // A working key lets the shared user past the first-run key step, like a returning user.
  await seedOpenAIKey(admin, { id, email: env.userEmail, password: env.userPassword, login: env.userEmail.split("@")[0] });
  await signInContext(page.context(), env.userEmail, env.userPassword);

  await page.goto("/workspaces");
  await expect(page.getByRole("heading", { level: 1, name: "Workspaces" })).toBeVisible();
  await page.context().storageState({ path: AUTH_FILE });
});
