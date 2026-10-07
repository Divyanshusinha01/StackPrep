import { assert, assertEquals, assertInstanceOf, assertRejects } from "@std/assert";
import { PARSER_VERSION } from "@stackprep/code-parser";
import { NonRetriableError, RetryAfterError } from "inngest";
import type { CodeFilePayload } from "../_shared/code-index/mapper.ts";
import type { CodeMemoryRow } from "../_shared/code-index/memory.ts";
import { DEFAULT_CODE_INDEX_LIMITS } from "../_shared/code-index/select.ts";
import {
  GithubNotFoundError,
  GithubRateLimitedError,
  GithubUnexpectedResponseError,
  type RepositoryTreeEntry,
} from "../_shared/github-app.ts";
import type { JobQueue } from "../_shared/jobs.ts";
import {
  CODE_INDEX_FAILURE_MESSAGES,
  type CodeIndexDeps,
  handleCodeIndexFailure,
  runCodeIndex,
} from "./code-index.ts";
import type { CodeIndexStore, CodeIndexTarget } from "./code-index-store.ts";
import type { StepRunner } from "./function.ts";
import { MEMORY_EMBEDDING_EVENT } from "./memory-embedding.ts";

const SHA = "c".repeat(40);
const OTHER_SHA = "d".repeat(40);
const event = {
  workspace_id: "aaaaaaaa-0000-4000-8000-000000000001",
  job_id: "dddddddd-0000-4000-8000-000000000003",
  commit_sha: SHA,
};

const SECRET = `ghs_${"Z".repeat(36)}`;
const SOURCE_MARKER = "raw-source-marker-should-never-persist";

const FILES: Record<string, string> = {
  "src/index.ts": `import { login } from "./auth/login.js";\nimport { z } from "zod";\n\nexport function main() {\n  return login("${SOURCE_MARKER}");\n}\n`,
  "src/auth/login.ts": `export class Session {\n  refresh() {\n    return 1;\n  }\n}\n\nexport function login(name: string) {\n  return new Session();\n}\n`,
  "src/auth/config.ts": `export const token = "${SECRET}";\n`,
  "src/broken.ts": "export function broken( {\n  return\n",
  "api/handler.py": "from .models import User\n\n\ndef handle(request):\n    return User()\n",
  "api/models.py": "class User:\n    pass\n",
  "src/blob.ts": "\u0000\u0001binary",
  "README.md": "# Demo\n",
  ".env": `TOKEN=${SECRET}`,
  "node_modules/x/index.js": "module.exports = 1;\n",
  "src/generated.min.js": "var a=1;\n",
};

function shaFor(path: string): string {
  let h = 0;
  for (const c of path) {
    h = (h * 31 + c.charCodeAt(0)) >>> 0;
  }
  return h.toString(16).padStart(40, "0");
}

function tree(files: Record<string, string> = FILES): RepositoryTreeEntry[] {
  return Object.entries(files).map(([path, text]) => ({ path, type: "blob", sha: shaFor(path), size: new TextEncoder().encode(text).length }));
}

function target(extra: Partial<CodeIndexTarget> = {}): CodeIndexTarget {
  return {
    job_id: event.job_id,
    job_status: "queued",
    workspace_id: event.workspace_id,
    commit_sha: SHA,
    owner: "alice",
    name: "demo",
    installation_id: 7,
    suspended: false,
    ...extra,
  };
}

interface Setup {
  target?: CodeIndexTarget | null;
  files?: Record<string, string>;
  entries?: RepositoryTreeEntry[];
  blobError?: (path: string) => Error | null;
  prune?: () => Promise<number>;
  limits?: Partial<typeof DEFAULT_CODE_INDEX_LIMITS>;
}

function setup({ target: t = target(), files = FILES, entries, blobError, prune, limits }: Setup = {}) {
  const calls: string[] = [];
  const replaced: { commit: string; version: string; files: CodeFilePayload[] }[] = [];
  const memory: CodeMemoryRow[][] = [];
  const completed: { commit: string; version: string; summary: Record<string, unknown> }[] = [];
  const pruned: string[][] = [];
  const failures: [string, string][] = [];
  const stages: number[] = [];
  const enqueued: [string, unknown][] = [];
  const logs: string[] = [];
  const treeEntries = entries ?? tree(files);

  const store: CodeIndexStore = {
    loadTarget: (jobId, workspaceId) => {
      calls.push(`load:${jobId}:${workspaceId}`);
      return Promise.resolve(t);
    },
    markStage: (_jobId, progress) => {
      stages.push(progress);
      return Promise.resolve();
    },
    replaceFiles: (_w, commit, version, batch) => {
      calls.push(`replace:${batch.length}`);
      replaced.push({ commit, version, files: batch });
      return Promise.resolve(batch.length);
    },
    saveMemory: (_w, _j, _c, rows) => {
      calls.push("save-memory");
      memory.push(rows);
      return Promise.resolve(rows.length);
    },
    complete: (_w, _j, commit, version, summary) => {
      calls.push("complete");
      completed.push({ commit, version, summary });
      return Promise.resolve();
    },
    listRetainedCommits: () => Promise.resolve([OTHER_SHA]),
    prune: (_w, keep) => {
      pruned.push(keep);
      return prune ? prune() : Promise.resolve(3);
    },
    fail: (_w, _j, code, message) => {
      failures.push([code, message]);
      return Promise.resolve();
    },
  };

  const jobs: JobQueue = {
    enqueue: (name, payload) => {
      enqueued.push([name, payload]);
      return Promise.resolve({ eventId: "evt" });
    },
  };

  const github: CodeIndexDeps["github"] = {
    getRepositoryTree: (installationId, owner, name, sha) => {
      calls.push(`tree:${installationId}:${owner}/${name}@${sha}`);
      return Promise.resolve({ entries: treeEntries, truncated: false });
    },
    getBlob: (_i, _o, _n, blobSha) => {
      const path = treeEntries.find((e) => e.sha === blobSha)!.path;
      calls.push(`blob:${path}`);
      const err = blobError?.(path);
      return err ? Promise.reject(err) : Promise.resolve(new TextEncoder().encode(files[path]));
    },
  };

  const deps: CodeIndexDeps = {
    github,
    store,
    jobs,
    limits: { ...DEFAULT_CODE_INDEX_LIMITS, batchFiles: 3, ...limits },
    log: (line) => logs.push(line),
  };
  return { deps, calls, replaced, memory, completed, pruned, failures, stages, enqueued, logs };
}

function stepRunner(memo = new Map<string, unknown>()) {
  const order: string[] = [];
  const step: StepRunner = {
    async run<T>(id: string, fn: () => Promise<T>): Promise<T> {
      if (memo.has(id)) {
        return memo.get(id) as T;
      }
      order.push(id);
      const value = JSON.parse(JSON.stringify(await fn() ?? null)) as T;
      memo.set(id, value);
      return value;
    },
  };
  return { step, order, memo };
}

function byPath(replaced: { files: CodeFilePayload[] }[]): Map<string, CodeFilePayload> {
  return new Map(replaced.flatMap((r) => r.files).map((f) => [f.path, f]));
}

Deno.test("a run selects parseable files, indexes them in batches, writes memory, completes, prunes and queues embedding", async () => {
  const { deps, calls, replaced, memory, completed, pruned, stages, enqueued } = setup();
  const { step, order } = stepRunner();
  const result = await runCodeIndex(deps, { data: event, runId: "run-1", step });

  assertEquals(result, { outcome: "indexed", files: 7, memory_rows: memory[0].length });
  assertEquals(order, [
    "verify",
    "select",
    "index-batch-0",
    "index-batch-1",
    "index-batch-2",
    "save-memory",
    "complete",
    "prune",
    "queue-memory-embedding",
  ]);
  assertEquals(replaced.map((r) => r.files.length), [3, 3, 1]);
  assert(replaced.every((r) => r.commit === SHA && r.version === PARSER_VERSION));
  assertEquals(stages[0], 10);
  assert(stages.every((p, i) => i === 0 || p >= stages[i - 1]), "progress never goes backwards");

  for (const path of [".env", "README.md", "node_modules/x/index.js", "src/generated.min.js"]) {
    assert(!calls.includes(`blob:${path}`), `${path} must never be fetched`);
    assert(!byPath(replaced).has(path), `${path} is not recorded`);
  }

  const files = byPath(replaced);
  assertEquals(files.get("src/auth/config.ts")?.parse_status, "skipped");
  assertEquals(files.get("src/auth/config.ts")?.skipped_reason, "secret");
  assertEquals(files.get("src/auth/config.ts")?.symbols, []);
  assertEquals(files.get("src/blob.ts")?.skipped_reason, "not_utf8");
  assertEquals(files.get("src/broken.ts")?.parse_status, "partial");

  const login = files.get("src/auth/login.ts")!;
  assertEquals(login.parse_status, "ok");
  assertEquals(login.symbols.map((s) => [s.name, s.kind, s.parent_ord, s.exported]), [
    ["Session", "class", null, true],
    ["refresh", "method", 0, false],
    ["login", "function", null, true],
  ]);
  assertEquals(files.get("src/index.ts")?.imports.map((i) => [i.source, i.resolved_path]), [
    ["./auth/login.js", "src/auth/login.ts"],
    ["zod", null],
  ]);
  assertEquals(files.get("api/handler.py")?.imports.map((i) => i.resolved_path), ["api/models.py"]);

  const kinds = memory[0].map((r) => `${r.kind}:${r.structured.path}`);
  assert(kinds.includes("code_module:src/auth/"));
  assert(kinds.includes("file_summary:src/auth/login.ts"));
  assert(memory[0].every((r) => r.metadata.source === "code_index" && r.metadata.commit_sha === SHA));

  assertEquals(completed.length, 1);
  assertEquals(completed[0].commit, SHA);
  assertEquals((completed[0].summary.selection as Record<string, number>).selected, 7);
  assertEquals(pruned, [[SHA, OTHER_SHA].sort()]);
  assertEquals(enqueued, [[MEMORY_EMBEDDING_EVENT, event]]);
});

Deno.test("persisted facts, memory, step outputs and logs carry no source text or secrets", async () => {
  const { deps, replaced, memory, logs } = setup();
  const { step, memo } = stepRunner();
  await runCodeIndex(deps, { data: event, runId: "r", step });
  for (const haystack of [JSON.stringify(replaced), JSON.stringify(memory), JSON.stringify([...memo.values()]), logs.join("\n")]) {
    assert(!haystack.includes(SECRET), "secret leaked");
    assert(!haystack.includes(SOURCE_MARKER), "source leaked");
  }
});

Deno.test("a failing blob is recorded for that file only and the run continues", async () => {
  const { deps, replaced, completed } = setup({
    blobError: (path) => path === "src/auth/login.ts" ? new GithubUnexpectedResponseError({ status: 500 }) : null,
  });
  const result = await runCodeIndex(deps, { data: event, runId: "r", step: stepRunner().step });
  assertEquals(result.outcome, "indexed");
  const files = byPath(replaced);
  assertEquals(files.get("src/auth/login.ts")?.skipped_reason, "fetch_failed");
  assertEquals(files.get("src/index.ts")?.parse_status, "ok");
  assertEquals(completed.length, 1);
});

Deno.test("oversized files are recorded as skipped without being fetched", async () => {
  const big = "export const x = 1;\n".repeat(400);
  const { deps, calls, replaced } = setup({
    files: { "src/big.ts": big, "src/small.ts": "export const y = 2;\n" },
    limits: { maxFileBytes: 1024 },
  });
  await runCodeIndex(deps, { data: event, runId: "r", step: stepRunner().step });
  assert(!calls.includes("blob:src/big.ts"));
  assertEquals(byPath(replaced).get("src/big.ts")?.skipped_reason, "too_large");
  assertEquals(byPath(replaced).get("src/small.ts")?.parse_status, "ok");
});

Deno.test("a GitHub rate limit retries the batch and a replay reuses the completed steps", async () => {
  let limited = true;
  const { deps, calls, replaced } = setup({
    blobError: (path) => {
      // Second batch in relevance order; the first batch completes before the limit hits.
      if (path === "src/broken.ts" && limited) {
        limited = false;
        return new GithubRateLimitedError(30);
      }
      return null;
    },
  });
  const memo = new Map<string, unknown>();
  const err = await assertRejects(() => runCodeIndex(deps, { data: event, runId: "r", step: stepRunner(memo).step }));
  assertInstanceOf(err, RetryAfterError);
  assertEquals(err.message, "github_rate_limited");
  assertEquals(replaced.length, 1);

  const result = await runCodeIndex(deps, { data: event, runId: "r", step: stepRunner(memo).step });
  assertEquals(result.outcome, "indexed");
  assertEquals(calls.filter((c) => c.startsWith("tree:")).length, 1, "the tree is fetched once");
  assertEquals(replaced.length, 3, "only the unfinished batches run again");
});

Deno.test("lost access while fetching is non-retriable", async () => {
  const { deps } = setup({ blobError: () => new GithubNotFoundError({ status: 404 }) });
  const err = await assertRejects(() => runCodeIndex(deps, { data: event, runId: "r", step: stepRunner().step }));
  assertInstanceOf(err, NonRetriableError);
  assertEquals(err.message, "installation_unavailable");
});

Deno.test("re-indexing the same commit produces identical payloads and memory", async () => {
  const first = setup();
  await runCodeIndex(first.deps, { data: event, runId: "r1", step: stepRunner().step });
  const second = setup();
  await runCodeIndex(second.deps, { data: event, runId: "r2", step: stepRunner().step });
  assertEquals(JSON.stringify(second.replaced), JSON.stringify(first.replaced));
  assertEquals(JSON.stringify(second.memory), JSON.stringify(first.memory));
});

Deno.test("an already succeeded job does nothing", async () => {
  const { deps, calls } = setup({ target: target({ job_status: "succeeded" }) });
  const result = await runCodeIndex(deps, { data: event, runId: "r", step: stepRunner().step });
  assertEquals(result, { outcome: "skipped", reason: "already_succeeded" });
  assertEquals(calls.length, 1);
});

Deno.test("a job for another workspace or commit is rejected before any GitHub call", async () => {
  const cases: [CodeIndexTarget | null, string][] = [
    [null, "internal_error"],
    [target({ commit_sha: OTHER_SHA }), "internal_error"],
    [target({ workspace_id: "aaaaaaaa-0000-4000-8000-000000000099" }), "internal_error"],
    [target({ installation_id: null }), "installation_unavailable"],
    [target({ suspended: true }), "installation_unavailable"],
  ];
  for (const [t, code] of cases) {
    const { deps, calls } = setup({ target: t });
    const err = await assertRejects(() => runCodeIndex(deps, { data: event, runId: "r", step: stepRunner().step }));
    assertInstanceOf(err, NonRetriableError);
    assertEquals(err.message, code);
    assertEquals(calls.filter((c) => !c.startsWith("load:")), []);
  }
});

Deno.test("an invalid event is non-retriable and never touches the store", async () => {
  const { deps, calls } = setup();
  for (const data of [{}, { ...event, job_id: "nope" }, { ...event, commit_sha: "HEAD" }]) {
    const err = await assertRejects(() => runCodeIndex(deps, { data, runId: "r", step: stepRunner().step }));
    assertInstanceOf(err, NonRetriableError);
  }
  assertEquals(calls, []);
});

Deno.test("a failed prune is swallowed and the index still completes", async () => {
  const { deps, completed, enqueued, logs } = setup({ prune: () => Promise.reject(new Error("db down")) });
  const result = await runCodeIndex(deps, { data: event, runId: "r", step: stepRunner().step });
  assertEquals(result.outcome, "indexed");
  assertEquals(completed.length, 1);
  assertEquals(enqueued.length, 1);
  assert(logs.some((l) => JSON.parse(l).event === "code_index_prune_failed"));
  assert(!logs.join("\n").includes("db down"));
});

Deno.test("onFailure records a fixed code and message, never the raw error", async () => {
  const { deps, failures, logs } = setup();
  await handleCodeIndexFailure(deps, { data: event, error: new Error("github_unavailable") });
  await handleCodeIndexFailure(deps, { data: event, error: new Error(`boom ${SECRET}`) });
  assertEquals(failures, [
    ["github_unavailable", CODE_INDEX_FAILURE_MESSAGES.github_unavailable],
    ["internal_error", CODE_INDEX_FAILURE_MESSAGES.internal_error],
  ]);
  assert(!logs.join("\n").includes(SECRET));

  const invalid = setup();
  await handleCodeIndexFailure(invalid.deps, { data: { nope: true }, error: new Error("x") });
  assertEquals(invalid.failures, []);
});
