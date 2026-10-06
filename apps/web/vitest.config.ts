import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Playwright specs; run with `pnpm test:e2e`.
    exclude: [...configDefaults.exclude, "e2e/**"],
  },
});
