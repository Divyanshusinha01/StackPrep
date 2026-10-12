import type { Inngest } from "inngest";
import type { JobQueue } from "../_shared/jobs.ts";
import type { StepRunner } from "./function.ts";
import { PUSH_SYNC_EVENT } from "./push-sync.ts";
import type { PushSyncStore } from "./push-sync-store.ts";

export const PUSH_RECONCILE_FUNCTION_ID = "repository-push-reconcile";
export const PUSH_RECONCILE_CRON = "*/10 * * * *";
export const PUSH_RECONCILE_LIMIT = 100;
const FN = "inngest";

export interface PushReconcileDeps {
  store: Pick<PushSyncStore, "listPending">;
  jobs: JobQueue;
  log?: (line: string) => void;
}

export interface PushReconcileResult {
  pending: number;
  emitted: number;
  failed: number;
}

/**
 * Re-emits `repository.push.received` for every ready workspace whose push is still pending once
 * no analysis job is active. Recovers lost webhook enqueues, Inngest outages and push syncs that
 * ran out of attempts. The event id carries the push generation, so each generation is re-emitted
 * at most once; a newer push gets a new id.
 */
export async function runPushReconcile(
  deps: PushReconcileDeps,
  { step }: { step: StepRunner },
): Promise<PushReconcileResult> {
  const pending = await step.run("list-pending", () => deps.store.listPending(PUSH_RECONCILE_LIMIT));

  const sent = await step.run("emit", async () => {
    const results = await Promise.allSettled(pending.map((p) =>
      deps.jobs.enqueue(PUSH_SYNC_EVENT, {
        workspace_id: p.workspace_id,
        installation_id: p.installation_id,
        dedupe_key: `reconcile:${p.workspace_id}:${p.push_generation}`,
      })
    ));
    // A failed send is picked up again by the next tick; nothing is lost while the push is pending.
    const failed = results.filter((r) => r.status === "rejected").length;
    return { emitted: results.length - failed, failed };
  });

  const result = { pending: pending.length, ...sent };
  (deps.log ?? console.log)(JSON.stringify({ fn: FN, event: "push_reconcile_completed", ...result }));
  return result;
}

export function createPushReconcileFunction(inngest: Inngest.Any, deps: PushReconcileDeps) {
  return inngest.createFunction(
    {
      id: PUSH_RECONCILE_FUNCTION_ID,
      name: "Repository push reconcile",
      triggers: [{ cron: PUSH_RECONCILE_CRON }],
      concurrency: { limit: 1 },
      retries: 2,
    },
    ({ step }) =>
      runPushReconcile(deps, {
        step: { run: <T>(id: string, fn: () => Promise<T>) => step.run(id, fn) as Promise<T> },
      }),
  );
}
