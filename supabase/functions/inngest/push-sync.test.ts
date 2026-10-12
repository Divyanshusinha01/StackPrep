import { assert, assertEquals, assertInstanceOf, assertRejects } from "@std/assert";
import { NonRetriableError } from "inngest";
import { GithubNotFoundError } from "../_shared/github-app.ts";
import type { JobEvents, JobQueue } from "../_shared/jobs.ts";
import { ANALYSIS_EVENT, FAILURE_MESSAGES } from "./function.ts";
import { ATTEMPT_BACKOFFS, MAX_ATTEMPTS, type PushSyncDeps, type PushSyncStepRunner, runPushSync } from "./push-sync.ts";
import type { FollowResult, PushSyncStore, PushSyncWorkspace } from "./push-sync-store.ts";

const WS = "aaaaaaaa-0000-4000-8000-000000000001";
const REPO = "bbbbbbbb-0000-4000-8000-000000000002";
const INDEXED = "a".repeat(40);
const NEW_HEAD = "c".repeat(40);
const NEWER_HEAD = "e".repeat(40);
const event = { workspace_id: WS, installation_id: 501, dedupe_key: `push:delivery:${WS}` };

/** In-memory model of the workspace row and `follow_repository_head`. */
class FakeWorkspace {
  status: PushSyncWorkspace["status"] = "ready";
  push = 1;
  synced = 0;
  target = INDEXED;
  indexed = INDEXED;
  active = false;
  targetFailed = false;
  jobs = 0;

  follow(commit: string, observed: number): FollowResult {
    if (this.status !== "ready") {
      return { job_id: null, outcome: "not_ready" };
    }
    if (this.active) {
      return { job_id: null, outcome: "analysis_active" };
    }
    let jobId: string | null = null;
    if (commit !== this.indexed && !(commit === this.target && !this.targetFailed)) {
      this.jobs++;
      jobId = `dddddddd-0000-4000-8000-00000000000${this.jobs}`;
      this.active = true;
      this.targetFailed = false;
    }
    this.target = commit;
    this.synced = Math.max(this.synced, Math.min(observed, this.push));
    return { job_id: jobId, outcome: jobId ? "queued" : "up_to_date" };
  }
}

interface Setup {
  workspace?: Partial<PushSyncWorkspace> | null;
  heads?: string[];
  onHead?: (call: number, ws: FakeWorkspace) => void;
  onSleep?: (id: string, ws: FakeWorkspace) => void;
  enqueueError?: Error;
  headError?: Error;
}

function setup({ workspace, heads = [NEW_HEAD], onHead, onSleep, enqueueError, headError }: Setup = {}) {
  const ws = new FakeWorkspace();
  const calls: string[] = [];
  const enqueued: [string, JobEvents["repository.analysis.requested"]][] = [];
  const failures: [string, string, string][] = [];
  const reopened: number[] = [];
  const logs: string[] = [];
  let headCalls = 0;

  const loaded: PushSyncWorkspace | null = workspace === null ? null : {
    workspace_id: WS,
    repository_id: REPO,
    status: "ready",
    owner: "acme",
    name: "api",
    installation_id: 501,
    suspended: false,
    ...workspace,
  };

  const store: PushSyncStore = {
    loadWorkspace: () => {
      calls.push("load");
      return Promise.resolve(loaded);
    },
    readGenerations: () => {
      calls.push("observe");
      return Promise.resolve({ push_generation: ws.push, synced_generation: ws.synced });
    },
    followHead: (_w, commit, observed) => {
      calls.push(`follow:${commit.slice(0, 1)}:${observed}`);
      return Promise.resolve(ws.follow(commit, observed));
    },
    reopen: (_w, observed) => {
      reopened.push(observed);
      if (ws.synced === observed) {
        ws.synced = observed - 1;
      }
      return Promise.resolve(true);
    },
    failAnalysis: (_w, jobId, code, message) => {
      failures.push([jobId, code, message]);
      ws.active = false;
      ws.targetFailed = true;
      return Promise.resolve();
    },
    listPending: () => Promise.resolve([]),
  };

  const github: PushSyncDeps["github"] = {
    getRepositoryHead: (installationId, owner, name) => {
      calls.push(`head:${installationId}:${owner}/${name}`);
      if (headError) {
        return Promise.reject(headError);
      }
      const call = headCalls++;
      onHead?.(call, ws);
      return Promise.resolve({ defaultBranch: "main", commitSha: heads[Math.min(call, heads.length - 1)] });
    },
  };

  const jobs: JobQueue = {
    enqueue: (name, payload) => {
      if (enqueueError) {
        return Promise.reject(enqueueError);
      }
      enqueued.push([name, payload as JobEvents["repository.analysis.requested"]]);
      return Promise.resolve({ eventId: "evt" });
    },
  };

  const deps: PushSyncDeps = { github, store, jobs, log: (line) => logs.push(line) };
  return { deps, ws, calls, enqueued, failures, reopened, logs, onSleep };
}

function stepRunner(ws: FakeWorkspace, onSleep?: (id: string, ws: FakeWorkspace) => void, memo = new Map<string, unknown>()) {
  const order: string[] = [];
  const sleeps: [string, string][] = [];
  const step: PushSyncStepRunner = {
    async run<T>(id: string, fn: () => Promise<T>): Promise<T> {
      assert(!order.includes(id), `step id ${id} is reused`);
      if (memo.has(id)) {
        return memo.get(id) as T;
      }
      order.push(id);
      const value = JSON.parse(JSON.stringify(await fn() ?? null)) as T;
      memo.set(id, value);
      return value;
    },
    sleep(id, duration) {
      assert(!order.includes(id), `step id ${id} is reused`);
      order.push(id);
      sleeps.push([id, duration]);
      onSleep?.(id, ws);
      return Promise.resolve();
    },
  };
  return { step, order, sleeps, memo };
}

function run(s: ReturnType<typeof setup>, memo?: Map<string, unknown>) {
  const runner = stepRunner(s.ws, s.onSleep, memo);
  return { runner, result: runPushSync(s.deps, { data: event, step: runner.step }) };
}

Deno.test("a push moves the target to the new head and enqueues its analysis", async () => {
  const s = setup();
  const { runner, result } = run(s);
  assertEquals(await result, { outcome: "queued", job_id: "dddddddd-0000-4000-8000-000000000001", commit_sha: NEW_HEAD });
  assertEquals(runner.order, ["verify", "observe-0", "resolve-head-0", "advance-0", "enqueue"]);
  assertEquals(s.enqueued, [[ANALYSIS_EVENT, {
    workspace_id: WS,
    repository_id: REPO,
    job_id: "dddddddd-0000-4000-8000-000000000001",
    installation_id: 501,
    commit_sha: NEW_HEAD,
  }]]);
  assertEquals([s.ws.target, s.ws.indexed, s.ws.status], [NEW_HEAD, INDEXED, "ready"]);
  assertEquals([s.ws.push, s.ws.synced], [1, 1]);
});

Deno.test("a force push follows the actual branch head, and a rewind to the indexed commit is up to date", async () => {
  const forced = setup({ heads: [NEWER_HEAD] });
  assertEquals((await run(forced).result).outcome, "queued");
  assertEquals(forced.ws.target, NEWER_HEAD);

  const rewind = setup({ heads: [INDEXED] });
  assertEquals(await run(rewind).result, { outcome: "up_to_date" });
  assertEquals(rewind.enqueued, []);
  assertEquals([rewind.ws.target, rewind.ws.synced], [INDEXED, 1]);
});

Deno.test("an active analysis makes the run sleep and re-resolve the head, then analyze the newest head", async () => {
  const s = setup({
    heads: [NEW_HEAD, NEWER_HEAD],
    // A second push lands while the run waits, and the earlier analysis finishes.
    onSleep: (_id, ws) => {
      ws.push = 2;
      ws.active = false;
    },
  });
  s.ws.active = true;
  const { runner, result } = run(s);
  assertEquals(await result, { outcome: "queued", job_id: "dddddddd-0000-4000-8000-000000000001", commit_sha: NEWER_HEAD });
  assertEquals(runner.sleeps, [["wait-0", "1m"]]);
  assertEquals(s.calls.filter((c) => c.startsWith("head:")).length, 2, "the head is resolved on every attempt");
  assertEquals(s.calls.filter((c) => c.startsWith("follow:")), ["follow:c:1", "follow:e:2"]);
  assertEquals([s.ws.target, s.ws.synced], [NEWER_HEAD, 2]);
});

Deno.test("when attempts run out the run is deferred and the push stays pending", async () => {
  const s = setup();
  s.ws.active = true;
  const { runner, result } = run(s);
  assertEquals(await result, { outcome: "deferred", attempts: MAX_ATTEMPTS });
  assertEquals(runner.sleeps.map(([, d]) => d), [...ATTEMPT_BACKOFFS]);
  assertEquals(s.calls.filter((c) => c.startsWith("head:")).length, MAX_ATTEMPTS);
  assertEquals([s.ws.target, s.ws.push, s.ws.synced], [INDEXED, 1, 0]);
  assert(s.logs.some((l) => JSON.parse(l).event === "push_sync_deferred"));
});

Deno.test("a failed analysis enqueue fails the job and reopens the push", async () => {
  const s = setup({ enqueueError: new Error("inngest down") });
  assertEquals(await run(s).result, { outcome: "enqueue_failed", job_id: "dddddddd-0000-4000-8000-000000000001" });
  assertEquals(s.failures, [["dddddddd-0000-4000-8000-000000000001", "enqueue_failed", FAILURE_MESSAGES.enqueue_failed]]);
  assertEquals(s.reopened, [1]);
  assertEquals([s.ws.push, s.ws.synced, s.ws.indexed, s.ws.status], [1, 0, INDEXED, "ready"]);

  // The reconciler's next run queues the failed target again.
  const retry = setup();
  Object.assign(retry.ws, { target: NEW_HEAD, targetFailed: true });
  assertEquals((await run(retry).result).outcome, "queued");
});

Deno.test("a push marked after the generation was observed stays pending", async () => {
  const s = setup({ onHead: (_call, ws) => ws.push++ });
  assertEquals((await run(s).result).outcome, "queued");
  assertEquals([s.ws.push, s.ws.synced], [2, 1]);
});

Deno.test("nothing pending is up to date without calling GitHub", async () => {
  const s = setup();
  s.ws.synced = 1;
  assertEquals(await run(s).result, { outcome: "up_to_date" });
  assertEquals(s.calls, ["load", "observe"]);
});

Deno.test("a workspace that is not ready or whose installation is unusable is skipped and stays pending", async () => {
  const cases: [Partial<PushSyncWorkspace> | null, "not_ready" | "installation_unavailable"][] = [
    [null, "not_ready"],
    [{ status: "analyzing" }, "not_ready"],
    [{ installation_id: null }, "installation_unavailable"],
    [{ suspended: true }, "installation_unavailable"],
    [{ installation_id: 999 }, "installation_unavailable"],
  ];
  for (const [workspace, reason] of cases) {
    const s = setup({ workspace });
    assertEquals(await run(s).result, { outcome: "skipped", reason });
    assertEquals(s.calls, ["load"]);
    assertEquals([s.ws.push, s.ws.synced], [1, 0]);
  }
});

Deno.test("a replay reuses completed steps and never queues twice", async () => {
  const s = setup();
  const memo = new Map<string, unknown>();
  await run(s, memo).result;
  const before = [...s.calls];
  assertEquals((await run(s, memo).result).outcome, "queued");
  assertEquals(s.calls, before);
  assertEquals(s.enqueued.length, 1);
});

Deno.test("lost repository access is non-retriable and leaves the push pending", async () => {
  const s = setup({ headError: new GithubNotFoundError({ status: 404 }) });
  const err = await assertRejects(() => run(s).result);
  assertInstanceOf(err, NonRetriableError);
  assertEquals([s.ws.push, s.ws.synced], [1, 0]);
});

Deno.test("an invalid event is non-retriable and never touches the store", async () => {
  const s = setup();
  const runner = stepRunner(s.ws);
  for (const data of [{}, { ...event, workspace_id: "nope" }, { ...event, installation_id: 0 }]) {
    const err = await assertRejects(() => runPushSync(s.deps, { data, step: runner.step }));
    assertInstanceOf(err, NonRetriableError);
  }
  assertEquals(s.calls, []);
});
