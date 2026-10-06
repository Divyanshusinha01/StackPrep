import { defineConfig, devices } from "@playwright/test";
import { AUTH_FILE, loadE2EEnv } from "./e2e/support/env";
import { ensureToneWav } from "./e2e/support/media";

const env = loadE2EEnv();
const CI = !!process.env.CI;
const port = new URL(env.baseUrl).port || "3000";

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results",
  globalSetup: "./e2e/global-setup.ts",
  // One shared local database; revisit once per-test isolation has proven stable.
  fullyParallel: false,
  workers: 1,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: CI
    ? [["github"], ["html", { open: "never", outputFolder: "playwright-report" }]]
    : [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: env.baseUrl,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    locale: "en-US",
    timezoneId: "UTC",
    contextOptions: { reducedMotion: "reduce" },
    permissions: ["camera", "microphone"],
  },
  projects: [
    {
      name: "setup",
      testMatch: /auth\.setup\.ts$/,
    },
    {
      name: "chromium",
      testDir: "./e2e/tests",
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: AUTH_FILE,
        launchOptions: {
          args: [
            "--use-fake-device-for-media-stream",
            "--use-fake-ui-for-media-stream",
            `--use-file-for-fake-audio-capture=${ensureToneWav()}`,
            "--autoplay-policy=no-user-gesture-required",
          ],
        },
      },
    },
  ],
  webServer: {
    // CI runs the production build (closest to Vercel); locally `next dev` is faster to iterate on.
    command: CI ? `pnpm build && pnpm start --port ${port}` : `pnpm dev --port ${port}`,
    url: `${env.baseUrl}/login`,
    reuseExistingServer: !CI,
    timeout: 240_000,
    stdout: "pipe",
    env: {
      NEXT_PUBLIC_SUPABASE_URL: env.supabaseUrl,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: env.anonKey,
      NEXT_PUBLIC_GITHUB_APP_SLUG: "stackprep-e2e",
      NEXT_PUBLIC_SENTRY_DSN: "",
      SENTRY_ORG: "",
      SENTRY_PROJECT: "",
      SENTRY_AUTH_TOKEN: "",
      NEXT_TELEMETRY_DISABLED: "1",
    },
  },
});
