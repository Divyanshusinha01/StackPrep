import type { BrowserContext, Route } from "@playwright/test";

const EXTERNAL_APIS = [/^https:\/\/api\.openai\.com\//, /^https:\/\/api\.github\.com\//];

/**
 * Aborts and records every browser request to OpenAI or GitHub. Specific mocks (the Realtime
 * call) are registered later, so Playwright tries them first; anything else reaching these hosts
 * is a bug in the test setup and fails the test.
 */
export async function installNetworkGuard(context: BrowserContext): Promise<string[]> {
  const violations: string[] = [];
  const block = async (route: Route) => {
    violations.push(`${route.request().method()} ${route.request().url()}`);
    await route.abort("blockedbyclient");
  };
  for (const pattern of EXTERNAL_APIS) {
    await context.route(pattern, block);
  }
  return violations;
}
