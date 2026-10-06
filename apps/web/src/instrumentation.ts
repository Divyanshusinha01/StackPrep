import * as Sentry from "@sentry/nextjs";
import { sentryOptions } from "@/lib/sentry";

export function register() {
  const options = sentryOptions();
  if (options) {
    Sentry.init(options);
  }
}

export const onRequestError = Sentry.captureRequestError;
