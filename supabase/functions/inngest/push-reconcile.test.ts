import { assertEquals } from "@std/assert";
import type { JobEvents, JobQueue } from "../_shared/jobs.ts";
import type { StepRunner } from "./function.ts";
import { PUSH_RECONCILE_LIMIT, runPushReconcile } from "./push-reconcile.ts";
import { PUSH_SYNC_EVENT } from "./push-sync.ts";
import type { PendingPushWorkspace } from "./push-sync-store.ts";

const WS_A = "aaaaaaaa-0000-4000-8000-000000000001";
const WS_B = "bbbbbbbb-0000-4000-8000-000000000002";

function setup(pending: PendingPushWorkspace[], failFor: string | null = null) {
  const limits: number[] = [];
  const sent: [string, JobEvents["repository.push.received"]][] = [];
  const logs: string[] = [];
  const jobs: JobQueue = {
    enqueue: (name, payload) => {
      const push = payload as JobEvents["repository.push.received"];
      if (push.workspace_id === failFor) {
        return Promise.reject(new Error("inngest down"));
      }
      sent.push([name, push]);
      return Promise.resolve({ eventId: "evt" });
    },
  };
  const deps = {
    store: {
      listPending: (limit: number) => {
        limits.push(limit);
        return Promise.resolve(pending);
      },
    },
    jobs,
    log: (line: string) => logs.push(line),
  };
  return { deps, limits, sent, logs };
}

const step: StepRunner = { run: (_id, fn) => fn() };

Deno.test("pending workspaces are re-emitted once per push generation", async () => {
  const s = setup([
    { workspace_id: WS_A, installation_id: 501, push_generation: 3 },
    { workspace_id: WS_B, installation_id: 502, push_generation: 1 },
  ]);
  assertEquals(await runPushReconcile(s.deps, { step }), { pending: 2, emitted: 2, failed: 0 });
  assertEquals(s.limits, [PUSH_RECONCILE_LIMIT]);
  assertEquals(s.sent, [
    [PUSH_SYNC_EVENT, { workspace_id: WS_A, installation_id: 501, dedupe_key: `reconcile:${WS_A}:3` }],
    [PUSH_SYNC_EVENT, { workspace_id: WS_B, installation_id: 502, dedupe_key: `reconcile:${WS_B}:1` }],
  ]);
});

Deno.test("nothing pending emits nothing", async () => {
  const s = setup([]);
  assertEquals(await runPushReconcile(s.deps, { step }), { pending: 0, emitted: 0, failed: 0 });
  assertEquals(s.sent, []);
});

Deno.test("a failed emit is counted and the rest are still sent", async () => {
  const s = setup([
    { workspace_id: WS_A, installation_id: 501, push_generation: 2 },
    { workspace_id: WS_B, installation_id: 501, push_generation: 4 },
  ], WS_A);
  assertEquals(await runPushReconcile(s.deps, { step }), { pending: 2, emitted: 1, failed: 1 });
  assertEquals(s.sent.map(([, p]) => p.workspace_id), [WS_B]);
  assertEquals(JSON.parse(s.logs[0]).event, "push_reconcile_completed");
});
