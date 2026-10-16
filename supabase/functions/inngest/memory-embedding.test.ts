import { assert, assertEquals, assertInstanceOf, assertRejects } from "@std/assert";
import { NonRetriableError, RetryAfterError } from "inngest";
import {
  AIInvalidOutputError,
  AIRateLimitedError,
  AIRequestError,
  AIUnavailableError,
  type EmbeddingRequest,
} from "../_shared/ai/provider.ts";
import { REDACTED } from "../_shared/analysis/scrub.ts";
import type { AiUsageEntry } from "../_shared/ai-usage.ts";
import { OpenAIKeyMissingError, OpenAIKeyUnusableError } from "../_shared/ai/credentials.ts";
import {
  createFakeEmbeddingProvider,
  createFakeOpenAIClients,
  FAKE_CREDENTIAL_ID,
  fakeEmbedding,
  fakeUserOpenAIClients,
} from "../_shared/testing.ts";
import type { StepRunner } from "./function.ts";
import {
  buildEmbeddingInput,
  classifyMemoryEmbeddingError,
  EMBEDDING_INPUT_VERSION,
  embeddingInputHash,
  handleMemoryEmbeddingFailure,
  MAX_EMBEDDING_INPUT_CHARS,
  type MemoryEmbeddingDeps,
  memoryEmbeddingFailureCode,
  runMemoryEmbedding,
} from "./memory-embedding.ts";
import type { EmbeddingMarker, EmbeddingMemoryRow, MemoryEmbeddingStore } from "./memory-embedding-store.ts";

const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const USER_ID = "55555555-0000-4000-8000-000000000005";
const MODEL = "text-embedding-3-small";
const event = {
  workspace_id: "22222222-0000-4000-8000-000000000002",
  job_id: "44444444-0000-4000-8000-000000000004",
  commit_sha: SHA,
};

interface DbRow {
  id: string;
  commit_sha: string;
  kind: string;
  content: string;
  structured: Record<string, unknown>;
  metadata: Record<string, unknown>;
  updated_at: string;
  embedding: number[] | null;
}

function baseline(): DbRow[] {
  const row = (id: string, kind: string, content: string, commit = SHA): DbRow => ({
    id,
    commit_sha: commit,
    kind,
    content,
    structured: {},
    metadata: { analyzer_version: "lightweight-1" },
    updated_at: "t0",
    embedding: null,
  });
  return [
    row("r1", "architecture_summary", "Express API with JWT auth."),
    row("r2", "modules", "src/ (20 files)"),
    row("r3", "key_files", "src/server.ts; src/auth/jwt.ts"),
    row("r4", "configuration", "   "),
    row("old", "architecture_summary", "Old commit summary.", OTHER_SHA),
  ];
}

interface Setup {
  rows?: DbRow[];
  user?: string | null;
  respond?: (request: EmbeddingRequest) => number[][] | Error | Promise<number[][] | Error>;
  model?: string;
}

function setup({ rows = baseline(), user = USER_ID, respond, model = MODEL }: Setup = {}) {
  let clock = 0;
  const db = new Map(rows.map((r) => [r.id, r]));
  const usage: AiUsageEntry[] = [];
  const writes: string[] = [];
  const logs: string[] = [];
  const loads: (string[] | undefined)[] = [];
  /** Runs before every write attempt, to simulate a concurrent writer. */
  let beforeWrite: (id: string) => void = () => {};
  let failWrite: (id: string) => boolean = () => false;

  /** Applies a change like an UPDATE: the set_updated_at trigger bumps updated_at. */
  const update = (id: string, patch: Partial<DbRow>) => {
    Object.assign(db.get(id)!, patch, { updated_at: `t${++clock}` });
  };

  const store: MemoryEmbeddingStore = {
    recordAiUsage(entry) {
      usage.push(entry);
      return Promise.resolve("created");
    },
    loadWorkspaceUser: (workspaceId) => Promise.resolve(workspaceId === event.workspace_id ? user : null),
    loadRows(workspaceId, sha, ids) {
      loads.push(ids);
      assertEquals(workspaceId, event.workspace_id);
      const out: EmbeddingMemoryRow[] = [...db.values()]
        .filter((r) => r.commit_sha === sha && (!ids || ids.includes(r.id)))
        .map((r) => ({
          id: r.id,
          kind: r.kind,
          content: r.content,
          metadata: structuredClone(r.metadata),
          updated_at: r.updated_at,
          has_embedding: r.embedding !== null,
        }));
      return Promise.resolve(out);
    },
    writeEmbedding(_workspaceId, id, expectedUpdatedAt, embedding, metadata) {
      writes.push(id);
      beforeWrite(id);
      if (failWrite(id)) {
        return Promise.reject(new Error("db connection reset"));
      }
      const row = db.get(id);
      if (!row || row.updated_at !== expectedUpdatedAt) {
        return Promise.resolve(false);
      }
      update(id, { embedding, metadata });
      return Promise.resolve(true);
    },
  };

  const provider = createFakeEmbeddingProvider(respond);
  const openai = createFakeOpenAIClients(user ?? USER_ID, fakeUserOpenAIClients({ embeddings: provider }));
  const deps: MemoryEmbeddingDeps = { openai, model, store, log: (line) => logs.push(line) };
  return {
    deps,
    provider,
    openai,
    db,
    usage,
    writes,
    logs,
    loads,
    update,
    onWrite: (fn: (id: string) => void) => (beforeWrite = fn),
    failWriteWhen: (fn: (id: string) => boolean) => (failWrite = fn),
  };
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
      const value = JSON.parse(JSON.stringify(await fn() ?? null)) as T;
      memo.set(id, value);
      return value;
    },
  };
  return { step, order, memo };
}

function run(deps: MemoryEmbeddingDeps, step = stepRunner().step, runId = "run-1") {
  return runMemoryEmbedding(deps, { data: event, runId, step });
}

function marker(row: DbRow): EmbeddingMarker {
  return row.metadata.embedding as EmbeddingMarker;
}

Deno.test("embeds every row of the commit with content and stores the vector and marker", async () => {
  const { deps, provider, db, usage, logs } = setup();
  const { step, order } = stepRunner();
  const result = await run(deps, step);

  assertEquals(result, { outcome: "embedded", embedded: 3, superseded: 0, current: 0 });
  assertEquals(order, ["verify", "plan", "embed-batch-0"]);
  assertEquals(provider.calls.length, 1);
  assertEquals(provider.calls[0].model, MODEL);
  assertEquals(provider.calls[0].input, [
    "architecture_summary\nExpress API with JWT auth.",
    "modules\nsrc/ (20 files)",
    "key_files\nsrc/server.ts; src/auth/jwt.ts",
  ]);

  const r1 = db.get("r1")!;
  assertEquals(r1.embedding, fakeEmbedding("architecture_summary\nExpress API with JWT auth."));
  assertEquals(r1.metadata.analyzer_version, "lightweight-1", "existing metadata is kept");
  const { embedded_at, ...rest } = marker(r1);
  assertEquals(rest, {
    model: MODEL,
    dimensions: 1536,
    input_hash: await embeddingInputHash(MODEL, r1),
    input_version: EMBEDDING_INPUT_VERSION,
  });
  assert(!Number.isNaN(Date.parse(embedded_at)));
  assertEquals(db.get("r4")!.embedding, null, "rows without content are skipped");
  assertEquals(db.get("old")!.embedding, null, "another commit is never touched");

  assertEquals(usage.length, 1);
  const { idempotencyKey, ...row } = usage[0];
  assertEquals(row, {
    userId: USER_ID,
    workspaceId: event.workspace_id,
    interviewId: null,
    task: "embedding",
    model: MODEL,
    source: "provider",
    tokens: { input_tokens: 21 },
    openaiCredentialId: FAKE_CREDENTIAL_ID,
  });
  assert(idempotencyKey.startsWith(`embedding:${event.job_id}:run-1:0:`));
  assertEquals(JSON.parse(logs.at(-1)!).event, "memory_embedding_completed");
});

Deno.test("a second run with unchanged content is up to date and never calls the provider", async () => {
  const { deps, provider, usage, logs } = setup();
  await run(deps);
  const result = await run(deps, stepRunner().step, "run-2");
  assertEquals(result, { outcome: "skipped", reason: "up_to_date" });
  assertEquals(provider.calls.length, 1);
  assertEquals(usage.length, 1);
  assertEquals(JSON.parse(logs.at(-1)!).reason, "up_to_date");
});

Deno.test("a structured- or metadata-only change does not re-embed; new concepts content embeds only that row", async () => {
  const { deps, provider, db, update } = setup();
  await run(deps);

  // What save_deep_analysis does to baseline rows: structured.ai and the metadata marker.
  update("r1", { structured: { ai: { summary: "AI" } }, metadata: { ...db.get("r1")!.metadata, deep_analysis: { model: "m" } } });
  update("r2", { structured: { ai: { important_modules: [] } } });
  db.set("c1", {
    id: "c1",
    commit_sha: SHA,
    kind: "concepts",
    content: "React: UI library",
    structured: { ai: { concepts: [] } },
    metadata: {},
    updated_at: "t0",
    embedding: null,
  });

  const result = await run(deps, stepRunner().step, "run-2");
  assertEquals(result, { outcome: "embedded", embedded: 1, superseded: 0, current: 0 });
  assertEquals(provider.calls[1].input, ["concepts\nReact: UI library"]);

  // A rewritten concepts row (deep analysis re-run) has a new hash and is re-embedded.
  update("c1", { content: "React: UI library\nJWT: signed token" });
  await run(deps, stepRunner().step, "run-3");
  assertEquals(provider.calls[2].input, ["concepts\nReact: UI library\nJWT: signed token"]);
});

Deno.test("a model change or a stale input hash forces a re-embed", async () => {
  const first = setup();
  await run(first.deps);
  first.deps.model = "embed-other-1536";
  const result = await run(first.deps, stepRunner().step, "run-2");
  assertEquals(result.outcome, "embedded");
  assertEquals(first.provider.calls[1].input.length, 3);
  assertEquals(marker(first.db.get("r1")!).model, "embed-other-1536");

  // A marker written by an older input version carries a different hash.
  const stale = setup();
  await run(stale.deps);
  stale.update("r2", {
    metadata: { ...stale.db.get("r2")!.metadata, embedding: { ...marker(stale.db.get("r2")!), input_hash: "embed-0-hash" } },
  });
  await run(stale.deps, stepRunner().step, "run-2");
  assertEquals(stale.provider.calls[1].input, ["modules\nsrc/ (20 files)"]);
});

Deno.test("a retried batch after a partial write does not re-embed completed rows", async () => {
  const { deps, provider, db, failWriteWhen } = setup();
  let failed = false;
  failWriteWhen((id) => {
    if (id === "r2" && !failed) {
      failed = true;
      return true;
    }
    return false;
  });
  const memo = new Map<string, unknown>();
  const err = await assertRejects(() => run(deps, stepRunner(memo).step));
  assertEquals(memoryEmbeddingFailureCode(err), "internal_error");
  assert(!(err instanceof NonRetriableError));
  assert(db.get("r1")!.embedding !== null);

  const result = await run(deps, stepRunner(memo).step);
  assertEquals(result, { outcome: "embedded", embedded: 2, superseded: 0, current: 1 });
  assertEquals(provider.calls.length, 2);
  assertEquals(provider.calls[1].input, ["modules\nsrc/ (20 files)", "key_files\nsrc/server.ts; src/auth/jwt.ts"]);
});

Deno.test("compare-and-set: a content change mid-run is superseded, not clobbered", async () => {
  const { deps, db, update, onWrite } = setup();
  onWrite((id) => {
    if (id === "r1" && db.get("r1")!.content.startsWith("Express")) {
      update("r1", { content: "Rewritten summary." });
    }
  });
  const result = await run(deps);
  assertEquals(result, { outcome: "embedded", embedded: 2, superseded: 1, current: 0 });
  const r1 = db.get("r1")!;
  assertEquals([r1.content, r1.embedding, r1.metadata.embedding], ["Rewritten summary.", null, undefined]);
});

Deno.test("compare-and-set: a metadata-only change mid-run is retried once with fresh metadata and the same vector", async () => {
  const { deps, provider, db, update, onWrite, writes } = setup();
  let raced = false;
  onWrite((id) => {
    if (id === "r1" && !raced) {
      raced = true;
      update("r1", { metadata: { ...db.get("r1")!.metadata, deep_analysis: { model: "m" } }, structured: { ai: {} } });
    }
  });
  const result = await run(deps);
  assertEquals(result, { outcome: "embedded", embedded: 3, superseded: 0, current: 0 });
  assertEquals(provider.calls.length, 1, "the vector is reused");
  assertEquals(writes.filter((id) => id === "r1").length, 2);
  const r1 = db.get("r1")!;
  assertEquals(r1.metadata.deep_analysis, { model: "m" }, "the concurrent marker is preserved");
  assertEquals(marker(r1).input_hash, await embeddingInputHash(MODEL, r1));
});

Deno.test("compare-and-set: a second miss gives up instead of looping", async () => {
  const { deps, db, update, onWrite, writes } = setup();
  onWrite((id) => {
    if (id === "r1") {
      update("r1", { structured: { touched: writes.length } });
    }
  });
  const result = await run(deps);
  assertEquals(result, { outcome: "embedded", embedded: 2, superseded: 1, current: 0 });
  assertEquals(writes.filter((id) => id === "r1").length, 2);
  assertEquals(db.get("r1")!.embedding, null);
});

Deno.test("wrong-dimension or non-finite vectors are non-retriable and nothing is written", async () => {
  const vectors: ((n: number) => number[])[] = [
    () => new Array(3072).fill(0.01),
    () => new Array(768).fill(0.01),
    () => [...new Array(1535).fill(0.01), Number.NaN],
  ];
  for (const vector of vectors) {
    const { deps, db, usage, writes } = setup({ respond: (r) => r.input.map(() => vector(r.input.length)) });
    const err = await assertRejects(() => run(deps));
    assertInstanceOf(err, NonRetriableError);
    assertEquals(err.message, "embedding_dimension_mismatch");
    assertEquals(writes, []);
    assert([...db.values()].every((r) => r.embedding === null));
    assertEquals(usage.length, 1, "the spend is still recorded");
  }
});

Deno.test("batches are capped at 64 inputs", async () => {
  const rows: DbRow[] = Array.from({ length: 70 }, (_, i) => ({
    id: `f${String(i).padStart(2, "0")}`,
    commit_sha: SHA,
    kind: "file_summary",
    content: `file ${i}`,
    structured: {},
    metadata: {},
    updated_at: "t0",
    embedding: null,
  }));
  const { deps, provider, usage } = setup({ rows });
  const { step, order } = stepRunner();
  const result = await run(deps, step);
  assertEquals(result, { outcome: "embedded", embedded: 70, superseded: 0, current: 0 });
  assertEquals(order, ["verify", "plan", "embed-batch-0", "embed-batch-1"]);
  assertEquals(provider.calls.map((c) => c.input.length), [64, 6]);
  assertEquals(usage.length, 2);
  assert(usage[1].idempotencyKey.startsWith(`embedding:${event.job_id}:run-1:1:`));
});

Deno.test("no memory for the commit is non-retriable and never falls back to another commit", async () => {
  const { deps, provider, loads } = setup({ rows: baseline().filter((r) => r.commit_sha === OTHER_SHA) });
  const err = await assertRejects(() => run(deps));
  assertInstanceOf(err, NonRetriableError);
  assertEquals(err.message, "repository_memory_unavailable");
  assertEquals(provider.calls.length, 0);
  assertEquals(loads.length, 1);

  const missing = setup({ user: null });
  const e2 = await assertRejects(() => run(missing.deps));
  assertInstanceOf(e2, NonRetriableError);
  assertEquals(e2.message, "internal_error");
});

Deno.test("an invalid event is non-retriable and never touches the store", async () => {
  const { deps, loads } = setup();
  for (const data of [{}, { ...event, job_id: "nope" }, { ...event, commit_sha: "HEAD" }]) {
    const err = await assertRejects(() => runMemoryEmbedding(deps, { data, runId: "r", step: stepRunner().step }));
    assertInstanceOf(err, NonRetriableError);
  }
  assertEquals(loads, []);
});

Deno.test("provider errors map to retriable or non-retriable fixed codes", async () => {
  const limited = setup({ respond: () => new AIRateLimitedError(20) });
  const e1 = await assertRejects(() => run(limited.deps));
  assertInstanceOf(e1, RetryAfterError);
  assertEquals(e1.message, "ai_rate_limited");

  const down = setup({ respond: () => new AIUnavailableError(503) });
  const e2 = await assertRejects(() => run(down.deps));
  assert(!(e2 instanceof NonRetriableError));
  assertEquals(memoryEmbeddingFailureCode(e2), "ai_unavailable");
  assertEquals(down.usage, [], "no usage without a response");

  const malformed = classifyMemoryEmbeddingError(new AIInvalidOutputError("malformed"));
  assert(!(malformed instanceof NonRetriableError));
  assertEquals(malformed.message, "ai_invalid_output");
  const rejected = classifyMemoryEmbeddingError(new AIRequestError(400));
  assertInstanceOf(rejected, NonRetriableError);
  assertEquals(rejected.message, "internal_error");
  assertEquals(classifyMemoryEmbeddingError(new Error("db password=hunter2")).message, "internal_error");
});

Deno.test("embeddings use the workspace owner's key, and key failures are non-retriable", async () => {
  const { deps, openai } = setup();
  await run(deps);
  assertEquals(openai.calls, [USER_ID]);

  const cases: [Error, string][] = [
    [new OpenAIKeyMissingError(), "openai_key_unavailable"],
    [new OpenAIKeyUnusableError("invalid"), "openai_key_invalid"],
    [new OpenAIKeyUnusableError("quota_exhausted"), "openai_quota_exhausted"],
  ];
  for (const [error, code] of cases) {
    const s = setup();
    s.deps.openai = createFakeOpenAIClients(USER_ID, error);
    const err = await assertRejects(() => run(s.deps));
    assertInstanceOf(err, NonRetriableError);
    assertEquals(err.message, code);
    assertEquals(s.writes, []);
    assertEquals(s.usage, []);
  }
});

Deno.test("onFailure logs a fixed code, never the raw error", () => {
  const logs: string[] = [];
  const log = (line: string) => logs.push(line);
  handleMemoryEmbeddingFailure({ log }, { data: event, error: new Error("embedding_dimension_mismatch") });
  handleMemoryEmbeddingFailure({ log }, { data: event, error: new Error("boom sk-live-secret") });
  handleMemoryEmbeddingFailure({ log }, { data: { nope: true }, error: new Error("x") });
  const entries = logs.map((l) => JSON.parse(l));
  assertEquals(entries.map((e) => [e.event, e.code, e.job_id]), [
    ["memory_embedding_failed", "embedding_dimension_mismatch", event.job_id],
    ["memory_embedding_failed", "internal_error", event.job_id],
    ["memory_embedding_failed", "internal_error", undefined],
  ]);
  assert(!logs.join("\n").includes("sk-live-secret"));
});

Deno.test("the embedding input is kind and content only, scrubbed and capped", async () => {
  const secret = `ghs_${"Z".repeat(36)}`;
  assertEquals(buildEmbeddingInput({ kind: "concepts", content: "React: UI" }), "concepts\nReact: UI");
  const withStructured = { kind: "modules", content: "src/", structured: { ai: { purpose: "x" } } };
  assertEquals(buildEmbeddingInput(withStructured), "modules\nsrc/");
  assertEquals(buildEmbeddingInput({ kind: "k", content: `token ${secret}` }), `k\ntoken ${REDACTED}`);
  assertEquals(buildEmbeddingInput({ kind: "k", content: "x".repeat(20_000) }).length, MAX_EMBEDDING_INPUT_CHARS);

  const hash = await embeddingInputHash(MODEL, { kind: "k", content: "c" });
  assertEquals(hash, await embeddingInputHash(MODEL, { kind: "k", content: "c" }));
  assert(hash !== await embeddingInputHash("other", { kind: "k", content: "c" }));
  assert(hash !== await embeddingInputHash(MODEL, { kind: "k2", content: "c" }));
});
