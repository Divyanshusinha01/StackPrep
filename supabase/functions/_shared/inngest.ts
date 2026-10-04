import type { InngestEnv } from "@stackprep/shared";
import { Inngest } from "inngest";

export const INNGEST_APP_ID = "stackprep";

/** Set INNGEST_DEV=1 to route events and step calls through a local Inngest Dev Server. */
export function createInngestClient(env: InngestEnv): Inngest {
  return new Inngest({ id: INNGEST_APP_ID, eventKey: env.INNGEST_EVENT_KEY, signingKey: env.INNGEST_SIGNING_KEY });
}
