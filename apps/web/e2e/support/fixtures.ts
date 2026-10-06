import { test as base, expect } from "@playwright/test";
import { installNetworkGuard } from "./network-guard";
import { createTestUser, deleteTestUser, seedReadyWorkspace, type SeededWorkspace, type TestUser } from "./seed";
import { type AdminClient, createAdminClient, signInContext } from "./supabase";

interface TestFixtures {
  /** Fails the test if the browser tried to reach OpenAI or GitHub. */
  networkGuard: void;
  /** A fresh user, signed in on this test's browser context and deleted afterwards. */
  user: TestUser;
  /** A ready workspace owned by `user`. */
  workspace: SeededWorkspace;
}

interface WorkerFixtures {
  admin: AdminClient;
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  admin: [async ({}, use) => use(createAdminClient()), { scope: "worker" }],

  networkGuard: [
    async ({ context }, use) => {
      const violations = await installNetworkGuard(context);
      await use();
      expect(violations, "unexpected browser requests to external APIs").toEqual([]);
    },
    { auto: true },
  ],

  user: async ({ admin, context }, use) => {
    const user = await createTestUser(admin, "user");
    await signInContext(context, user.email, user.password);
    await use(user);
    await deleteTestUser(admin, user.id);
  },

  workspace: async ({ admin, user }, use) => {
    await use(await seedReadyWorkspace(admin, user));
  },
});

export { expect };
