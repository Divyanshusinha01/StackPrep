import { test as base, expect } from "@playwright/test";
import type { OpenAIKeyStatus } from "@stackprep/shared";
import { installNetworkGuard } from "./network-guard";
import {
  createTestUser,
  deleteTestUser,
  seedOpenAIKey,
  seedReadyWorkspace,
  type SeededWorkspace,
  type TestUser,
} from "./seed";
import { type AdminClient, createAdminClient, signInContext } from "./supabase";

interface TestOptions {
  /** The stored status of `user`'s seeded OpenAI key, or null for no key. Defaults to a working key. */
  openAIKeyStatus: OpenAIKeyStatus | null;
}

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

export const test = base.extend<TestOptions & TestFixtures, WorkerFixtures>({
  admin: [async ({}, use) => use(createAdminClient()), { scope: "worker" }],

  openAIKeyStatus: ["valid", { option: true }],

  networkGuard: [
    async ({ context }, use) => {
      const violations = await installNetworkGuard(context);
      await use();
      expect(violations, "unexpected browser requests to external APIs").toEqual([]);
    },
    { auto: true },
  ],

  user: async ({ admin, context, openAIKeyStatus }, use) => {
    const user = await createTestUser(admin, "user");
    if (openAIKeyStatus) {
      await seedOpenAIKey(admin, user, openAIKeyStatus);
    }
    await signInContext(context, user.email, user.password);
    await use(user);
    await deleteTestUser(admin, user.id);
  },

  workspace: async ({ admin, user }, use) => {
    await use(await seedReadyWorkspace(admin, user));
  },
});

export { expect };
