import * as Sentry from "@sentry/nextjs";
import { sentryOptions } from "@/lib/sentry";

const options = sentryOptions();
if (options) {
  Sentry.init(options);
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
