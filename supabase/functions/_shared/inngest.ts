import type { InngestEnv } from "@stackprep/shared";
import { Inngest, Middleware } from "inngest";
import { reportUnexpected, type SentryReporter } from "./sentry.ts";

export const INNGEST_APP_ID = "stackprep";

/** Builds the middleware; `reporter` defaults to the client set up by `initSentry`. */
export function createSentryMiddleware(reporter?: SentryReporter | null): Middleware.Class {
  return class SentryMiddleware extends Middleware.BaseMiddleware {
    readonly id = "sentry";

    /** Earlier attempts are retried by Inngest, so only the final failure of a run is reported. */
    override onRunError({ error, fn, isFinalAttempt }: Middleware.OnRunErrorArgs): void {
      if (isFinalAttempt) {
        reportUnexpected(error, { event: "inngest_run_failed", fn: fn.id() }, reporter);
      }
    }
  };
}

/**
 * Set INNGEST_DEV to the Dev Server URL to route events and step calls locally. Edge Functions run in
 * Docker, so use http://host.docker.internal:8288 rather than INNGEST_DEV=1 (which targets localhost).
 */
export function createInngestClient(env: InngestEnv): Inngest {
  return new Inngest({
    id: INNGEST_APP_ID,
    eventKey: env.INNGEST_EVENT_KEY,
    signingKey: env.INNGEST_SIGNING_KEY,
    middleware: [createSentryMiddleware()],
  });
}
