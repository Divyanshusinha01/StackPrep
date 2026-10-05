import type { InngestEnv } from "@stackprep/shared";
import { Inngest } from "inngest";

export const INNGEST_APP_ID = "stackprep";

/**
 * Set INNGEST_DEV to the Dev Server URL to route events and step calls locally. Edge Functions run in
 * Docker, so use http://host.docker.internal:8288 rather than INNGEST_DEV=1 (which targets localhost).
 */
export function createInngestClient(env: InngestEnv): Inngest {
  return new Inngest({ id: INNGEST_APP_ID, eventKey: env.INNGEST_EVENT_KEY, signingKey: env.INNGEST_SIGNING_KEY });
}
