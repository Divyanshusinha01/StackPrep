import { assertEquals } from "@std/assert";
import type { Middleware } from "inngest";
import { createInngestClient, createSentryMiddleware } from "./inngest.ts";
import type { SentryReporter } from "./sentry.ts";

Deno.test("Sentry middleware reports only the final failed attempt of a run", () => {
  const captured: Record<string, string | number>[] = [];
  const reporter: SentryReporter = {
    captureException: (_err, { tags }) => captured.push(tags),
    flush: () => Promise.resolve(true),
  };
  const client = createInngestClient({ INNGEST_EVENT_KEY: "test", INNGEST_SIGNING_KEY: "signkey-test-00" });
  const SentryMiddleware = createSentryMiddleware(reporter);
  const middleware = new SentryMiddleware({ client });
  const run = (isFinalAttempt: boolean) =>
    middleware.onRunError?.({
      ctx: {},
      error: new Error("step failed"),
      fn: { id: () => "repository-analysis" },
      isFinalAttempt,
    } as unknown as Middleware.OnRunErrorArgs);

  run(false);
  assertEquals(captured, []);
  run(true);
  assertEquals(captured, [{ event: "inngest_run_failed", fn: "repository-analysis" }]);
});
