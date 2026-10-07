import { assert, assertEquals, assertInstanceOf, assertRejects } from "@std/assert";
import { NonRetriableError, RetryAfterError } from "inngest";
import type { MemoryRow } from "../_shared/analysis/context.ts";
import {
  GithubNotFoundError,
  GithubRateLimitedError,
  GithubUnavailableError,
  GithubUnexpectedResponseError,
  type RepositoryTreeEntry,
} from "../_shared/github-app.ts";
import type { JobQueue } from "../_shared/jobs.ts";
import { DEEP_ANALYSIS_EVENT, DEEP_ANALYSIS_FAILURE_MESSAGES } from "./deep-analysis.ts";
import {
  type AnalysisDeps,
  classifyAnalysisError,
  FAILURE_MESSAGES,
  failureCode,
  handleAnalysisFailure,
  runRepositoryAnalysis,
  type StepRunner,
} from "./function.ts";
import { MEMORY_EMBEDDING_EVENT } from "./memory-embedding.ts";
import type { AnalysisStore, AnalysisTarget } from "./store.ts";

const SHA = "c".repeat(40);
const event = {
  workspace_id: "aaaaaaaa-0000-4000-8000-000000000001",
  repository_id: "bbbbbbbb-0000-4000-8000-000000000002",
  job_id: "dddddddd-0000-4000-8000-000000000003",
  installation_id: 7,
  commit_sha: SHA,
};

const SECRET = `ghs_${"Z".repeat(36)}`;
const SOURCE_MARKER = "raw-source-marker-should-never-persist";

const FILES: Record<string, string> = {
  "README.md": `# Demo\n\nA demo app. Deploy token: ${SECRET}\n`,
  "package.json": JSON.stringify({ name: "demo", dependencies: { next: "^16.0.0", react: "^19.0.0" } }),
  "src/index.ts": `import { z } from "zod";\nconst key = "${SECRET}";\nexport function main() { return "${SOURCE_MARKER}"; }\n`,
  ".env": `GITHUB_TOKEN=${SECRET}`,
  "logo.png": "\u0000\u0001binary",
};

function shaFor(path: string): string {
  let h = 0;
  for (const c of path) {
    h = (h * 31 + c.charCodeAt(0)) >>> 0;
  }
  return h.toString(16).padStart(40, "0");
}

const TREE: RepositoryTreeEntry[] = Object.entries(FILES).map(([path, text]) => ({
  path,
  type: "blob",
  sha: shaFor(path),
  size: text.length,
}));

function target(extra: Partial<AnalysisTarget> = {}): AnalysisTarget {
  return {
    job_id: event.job_id,
    job_status: "queued",
    job_commit_sha: SHA,
    workspace_id: event.workspace_id,
    repository_id: event.repository_id,
    target_commit_sha: SHA,
    owner: "alice",
    name: "demo",
    installation_id: 7,
    suspended: false,
    ...extra,
  };
}

const DEEP_JOB_ID = "eeeeeeee-0000-4000-8000-000000000004";

interface Setup {
  target?: AnalysisTarget | null;
  memoryCount?: number;
  ready?: boolean;
  tree?: () => Promise<{ entries: RepositoryTreeEntry[]; truncated: boolean }>;
  blobError?: () => Error | null;
  requestDeepAnalysis?: () => Promise<string | null>;
  enqueue?: () => Promise<{ eventId: string | null }>;
}

function setup({
  target: t = target(),
  memoryCount = 0,
  ready = true,
  tree,
  blobError,
  requestDeepAnalysis = () => Promise.resolve(DEEP_JOB_ID),
  enqueue = () => Promise.resolve({ eventId: "evt-1" }),
}: Setup = {}) {
  const calls: string[] = [];
  const stages: string[] = [];
  const completed: { memory: MemoryRow[] }[] = [];
  const failures: [string, string][] = [];
  const deepFailures: [string, string][] = [];
  const enqueued: [string, unknown][] = [];
  const logs: string[] = [];

  const store: AnalysisStore = {
    loadTarget: (jobId, workspaceId) => {
      calls.push(`load:${jobId}:${workspaceId}`);
      return Promise.resolve(t);
    },
    countMemory: () => Promise.resolve(memoryCount),
    markStage: (_jobId, stage, progress, runId) => {
      stages.push(`${stage}:${progress}:${runId}`);
      return Promise.resolve();
    },
    complete: (_w, _j, _sha, memory) => {
      calls.push("complete");
      completed.push({ memory });
      return Promise.resolve(ready);
    },
    fail: (_w, _j, code, message) => {
      failures.push([code, message]);
      return Promise.resolve();
    },
    requestDeepAnalysis: (workspaceId, sha) => {
      calls.push(`request-deep:${workspaceId}:${sha}`);
      return requestDeepAnalysis();
    },
    failDeepAnalysis: (_w, jobId, code, message) => {
      deepFailures.push([`${jobId}:${code}`, message]);
      return Promise.resolve();
    },
  };

  const jobs: JobQueue = {
    enqueue: (name, payload) => {
      calls.push(`enqueue:${name}`);
      enqueued.push([name, payload]);
      return enqueue();
    },
  };

  const github: AnalysisDeps["github"] = {
    getRepositoryTree: (installationId, owner, name, sha) => {
      calls.push(`tree:${installationId}:${owner}/${name}@${sha}`);
      return tree ? tree() : Promise.resolve({ entries: TREE, truncated: false });
    },
    getBlob: (installationId, _owner, _name, blobSha) => {
      calls.push(`blob:${installationId}:${blobSha}`);
      const err = blobError?.();
      if (err) {
        return Promise.reject(err);
      }
      const path = TREE.find((e) => e.sha === blobSha)!.path;
      return Promise.resolve(new TextEncoder().encode(FILES[path]));
    },
  };

  const deps: AnalysisDeps = { github, store, jobs, log: (line) => logs.push(line) };
  return { deps, calls, stages, completed, failures, deepFailures, enqueued, logs };
}

/** Records step outputs; memoizes completed steps across runs like Inngest's durable replay. */
function stepRunner(memo = new Map<string, unknown>()) {
  const order: string[] = [];
  const step: StepRunner = {
    async run<T>(id: string, fn: () => Promise<T>): Promise<T> {
      if (memo.has(id)) {
        return memo.get(id) as T;
      }
      order.push(id);
      const value = JSON.parse(JSON.stringify(await fn())) as T;
      memo.set(id, value);
      return value;
    },
  };
  return { step, order, memo };
}

Deno.test("a successful run scans, analyzes, prepares context, and completes", async () => {
  const { deps, calls, stages, completed } = setup();
  const { step, order } = stepRunner();
  const result = await runRepositoryAnalysis(deps, { data: event, runId: "run-1", step });

  assertEquals(result, { outcome: "completed", ready: true, memory_rows: 6 });
  assertEquals(order, ["verify", "check-existing", "scanning", "analyzing", "preparing_context", "complete", "queue-deep-analysis", "queue-memory-embedding"]);
  assertEquals(stages, ["scanning:10:run-1", "analyzing:40:run-1", "preparing_context:80:run-1"]);
  assertEquals(calls[0], `load:${event.job_id}:${event.workspace_id}`);
  assertEquals(calls[1], `tree:7:alice/demo@${SHA}`);
  assert(!calls.includes(`blob:7:${shaFor(".env")}`), ".env must never be fetched");
  assert(!calls.includes(`blob:7:${shaFor("logo.png")}`), "binaries must never be fetched");
  assertEquals(completed.length, 1);
  assertEquals(completed[0].memory.map((m) => m.kind), [
    "architecture_summary",
    "technologies",
    "modules",
    "key_files",
    "dependencies",
    "configuration",
  ]);
});

Deno.test("step outputs, persisted memory, and logs contain no secrets or raw source", async () => {
  const { deps, completed, logs } = setup();
  const { step, memo } = stepRunner();
  await runRepositoryAnalysis(deps, { data: event, runId: "run-1", step });
  for (const haystack of [JSON.stringify([...memo.values()]), JSON.stringify(completed), logs.join("\n")]) {
    assert(!haystack.includes(SECRET), "secret leaked");
    assert(!haystack.includes(SOURCE_MARKER), "raw source leaked");
  }
  const entry = JSON.parse(logs.find((l) => l.includes('"analysis_completed"'))!);
  assertEquals(entry.job_id, event.job_id);
});

Deno.test("a re-run for an already succeeded job does nothing", async () => {
  const { deps, calls, completed, stages } = setup({ target: target({ job_status: "succeeded" }) });
  const result = await runRepositoryAnalysis(deps, { data: event, runId: "run-2", step: stepRunner().step });
  assertEquals(result, { outcome: "skipped", reason: "already_succeeded", ready: true });
  assertEquals(calls.length, 1);
  assertEquals(completed, []);
  assertEquals(stages, []);
});

Deno.test("existing memory for the commit is reused instead of re-analyzing", async () => {
  const { deps, calls, completed } = setup({ memoryCount: 6 });
  const result = await runRepositoryAnalysis(deps, { data: event, runId: "run-3", step: stepRunner().step });
  assertEquals(result, { outcome: "skipped", reason: "memory_exists", ready: true });
  assert(!calls.some((c) => c.startsWith("tree:")));
  assertEquals(completed, [{ memory: [] }]);
});

Deno.test("Inngest replay after a transient failure reuses completed steps", async () => {
  let failOnce = true;
  const { deps, calls } = setup({
    blobError: () => {
      if (failOnce) {
        failOnce = false;
        return new GithubUnavailableError({ status: 502 });
      }
      return null;
    },
  });
  const memo = new Map<string, unknown>();
  const first = await assertRejects(() => runRepositoryAnalysis(deps, { data: event, runId: "r", step: stepRunner(memo).step }));
  assertEquals(failureCode(first), "github_unavailable");
  assert(!(first instanceof NonRetriableError));

  const result = await runRepositoryAnalysis(deps, { data: event, runId: "r", step: stepRunner(memo).step });
  assertEquals(result.outcome, "completed");
  assertEquals(calls.filter((c) => c.startsWith("tree:")).length, 1);
});

Deno.test("ownership and payload mismatches are rejected before any GitHub call", async () => {
  const cases: [AnalysisTarget | null, string][] = [
    [null, "internal_error"],
    [target({ repository_id: "bbbbbbbb-0000-4000-8000-000000000099" }), "internal_error"],
    [target({ target_commit_sha: "d".repeat(40) }), "internal_error"],
    [target({ job_commit_sha: "d".repeat(40) }), "internal_error"],
    [target({ installation_id: 8 }), "installation_unavailable"],
    [target({ installation_id: null }), "installation_unavailable"],
    [target({ suspended: true }), "installation_unavailable"],
  ];
  for (const [t, code] of cases) {
    const { deps, calls } = setup({ target: t });
    const err = await assertRejects(() => runRepositoryAnalysis(deps, { data: event, runId: "r", step: stepRunner().step }));
    assertInstanceOf(err, NonRetriableError);
    assertEquals(err.message, code);
    assertEquals(calls.filter((c) => !c.startsWith("load:")), []);
  }
});

Deno.test("an invalid event is non-retriable and never touches the store", async () => {
  const { deps, calls } = setup();
  for (const data of [{}, { ...event, job_id: "nope" }, { ...event, commit_sha: "HEAD" }]) {
    const err = await assertRejects(() => runRepositoryAnalysis(deps, { data, runId: "r", step: stepRunner().step }));
    assertInstanceOf(err, NonRetriableError);
  }
  assertEquals(calls, []);
});

Deno.test("GitHub errors map to retriable or non-retriable fixed codes", async () => {
  const uninstalled = setup({ tree: () => Promise.reject(new GithubNotFoundError({ status: 404 })) });
  const e1 = await assertRejects(() => runRepositoryAnalysis(uninstalled.deps, { data: event, runId: "r", step: stepRunner().step }));
  assertInstanceOf(e1, NonRetriableError);
  assertEquals(e1.message, "installation_unavailable");

  const gone = setup({ tree: () => Promise.reject(new GithubUnexpectedResponseError({ status: 404 })) });
  const e2 = await assertRejects(() => runRepositoryAnalysis(gone.deps, { data: event, runId: "r", step: stepRunner().step }));
  assertInstanceOf(e2, NonRetriableError);
  assertEquals(e2.message, "repository_unavailable");

  const limited = setup({ tree: () => Promise.reject(new GithubRateLimitedError(30)) });
  const e3 = await assertRejects(() => runRepositoryAnalysis(limited.deps, { data: event, runId: "r", step: stepRunner().step }));
  assertInstanceOf(e3, RetryAfterError);
  assertEquals(e3.message, "github_rate_limited");

  assertEquals(classifyAnalysisError(new GithubUnexpectedResponseError({ status: 500 })).message, "github_unexpected_response");
  assertEquals(classifyAnalysisError(new Error("connection refused: password=hunter2")).message, "internal_error");
});

Deno.test("deep analysis is requested and enqueued only after the baseline completes", async () => {
  const { deps, calls, enqueued } = setup();
  const result = await runRepositoryAnalysis(deps, { data: event, runId: "r", step: stepRunner().step });
  assertEquals(result, { outcome: "completed", ready: true, memory_rows: 6 });
  assertEquals(calls.slice(calls.indexOf("complete")), [
    "complete",
    `request-deep:${event.workspace_id}:${SHA}`,
    `enqueue:${DEEP_ANALYSIS_EVENT}`,
    `enqueue:${MEMORY_EMBEDDING_EVENT}`,
  ]);
  assertEquals(enqueued, [
    [DEEP_ANALYSIS_EVENT, { workspace_id: event.workspace_id, job_id: DEEP_JOB_ID, commit_sha: SHA }],
    [MEMORY_EMBEDDING_EVENT, { workspace_id: event.workspace_id, job_id: event.job_id, commit_sha: SHA }],
  ]);
});

Deno.test("reused memory also chains into deep analysis", async () => {
  const { deps, enqueued } = setup({ memoryCount: 6 });
  const { step, order } = stepRunner();
  const result = await runRepositoryAnalysis(deps, { data: event, runId: "r", step });
  assertEquals(result, { outcome: "skipped", reason: "memory_exists", ready: true });
  assertEquals(order, ["verify", "check-existing", "complete", "queue-deep-analysis", "queue-memory-embedding"]);
  assertEquals(enqueued.map(([name]) => name), [DEEP_ANALYSIS_EVENT, MEMORY_EMBEDDING_EVENT]);
});

Deno.test("a failed deep analysis request still returns the completed baseline", async () => {
  const { deps, enqueued, deepFailures, logs } = setup({ requestDeepAnalysis: () => Promise.reject(new Error("db down")) });
  const result = await runRepositoryAnalysis(deps, { data: event, runId: "r", step: stepRunner().step });
  assertEquals(result, { outcome: "completed", ready: true, memory_rows: 6 });
  assertEquals(enqueued.map(([name]) => name), [MEMORY_EMBEDDING_EVENT], "embedding is queued independently");
  assertEquals(deepFailures, []);
  assert(logs.some((l) => JSON.parse(l).event === "deep_analysis_enqueue_failed"));
  assert(!logs.join("\n").includes("db down"));
});

Deno.test("a failed enqueue records enqueue_failed on the deep job and keeps the baseline result", async () => {
  const { deps, deepFailures, failures, logs } = setup({ enqueue: () => Promise.reject(new Error("inngest down")) });
  const result = await runRepositoryAnalysis(deps, { data: event, runId: "r", step: stepRunner().step });
  assertEquals(result, { outcome: "completed", ready: true, memory_rows: 6 });
  assertEquals(deepFailures, [[`${DEEP_JOB_ID}:enqueue_failed`, DEEP_ANALYSIS_FAILURE_MESSAGES.enqueue_failed]]);
  assertEquals(failures, [], "the baseline job is never failed");
  const entry = JSON.parse(logs.find((l) => l.includes("deep_analysis_enqueue_failed"))!);
  assertEquals(entry.job_id, DEEP_JOB_ID);
});

Deno.test("no deep job id (already analyzed or active) skips the enqueue", async () => {
  const { deps, calls, enqueued } = setup({ requestDeepAnalysis: () => Promise.resolve(null) });
  const result = await runRepositoryAnalysis(deps, { data: event, runId: "r", step: stepRunner().step });
  assertEquals(result.outcome, "completed");
  assert(calls.some((c) => c.startsWith("request-deep:")));
  assertEquals(enqueued.map(([name]) => name), [MEMORY_EMBEDDING_EVENT]);
});

Deno.test("nothing is requested when the analyzed commit is no longer the workspace target", async () => {
  for (const memoryCount of [0, 6]) {
    const { deps, calls, enqueued } = setup({ ready: false, memoryCount });
    const { step, order } = stepRunner();
    const result = await runRepositoryAnalysis(deps, { data: event, runId: "r", step });
    assertEquals(result.ready, false);
    assert(!order.includes("queue-deep-analysis") && !order.includes("queue-memory-embedding"));
    assert(!calls.some((c) => c.startsWith("request-deep:")));
    assertEquals(enqueued, []);
  }
});

Deno.test("a replay after the chain step never queues a second deep job", async () => {
  const { deps, enqueued } = setup();
  const memo = new Map<string, unknown>();
  await runRepositoryAnalysis(deps, { data: event, runId: "r", step: stepRunner(memo).step });
  await runRepositoryAnalysis(deps, { data: event, runId: "r", step: stepRunner(memo).step });
  assertEquals(enqueued.map(([name]) => name), [DEEP_ANALYSIS_EVENT, MEMORY_EMBEDDING_EVENT]);
});

Deno.test("a failed embedding enqueue is swallowed and keeps the baseline result", async () => {
  const { deps, logs, failures } = setup({ enqueue: () => Promise.reject(new Error("inngest down")) });
  const result = await runRepositoryAnalysis(deps, { data: event, runId: "r", step: stepRunner().step });
  assertEquals(result, { outcome: "completed", ready: true, memory_rows: 6 });
  assertEquals(failures, []);
  const entry = JSON.parse(logs.find((l) => l.includes("memory_embedding_enqueue_failed"))!);
  assertEquals(entry.job_id, event.job_id);
  assert(!logs.join("\n").includes("inngest down"));
});

Deno.test("onFailure records a fixed code and message, never the raw error", async () => {
  const { deps, failures, logs } = setup();
  await handleAnalysisFailure(deps, { data: event, error: new Error("github_unavailable") });
  await handleAnalysisFailure(deps, { data: event, error: new Error(`boom ${SECRET}`) });
  assertEquals(failures, [
    ["github_unavailable", FAILURE_MESSAGES.github_unavailable],
    ["internal_error", FAILURE_MESSAGES.internal_error],
  ]);
  assert(!logs.join("\n").includes(SECRET));
  assert(!JSON.stringify(failures).includes(SECRET));

  const invalid = setup();
  await handleAnalysisFailure(invalid.deps, { data: { nope: true }, error: new Error("x") });
  assertEquals(invalid.failures, []);
  assertEquals(JSON.parse(invalid.logs[0]).recorded, false);
});
