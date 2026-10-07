import { gitCommitShaSchema, REPOSITORY_MEMORY_EMBEDDING_DIMENSIONS } from "@stackprep/shared";
import { type Inngest, NonRetriableError, RetryAfterError } from "inngest";
import { z } from "zod";
import {
  AIInvalidOutputError,
  AIRateLimitedError,
  AIRequestError,
  AIUnavailableError,
  assertEmbeddingDimensions,
  type EmbeddingProvider,
} from "../_shared/ai/provider.ts";
import { scrubSecrets } from "../_shared/analysis/scrub.ts";
import type { JobQueue } from "../_shared/jobs.ts";
import type { StepRunner } from "./function.ts";
import type { EmbeddingMarker, EmbeddingMemoryRow, MemoryEmbeddingStore } from "./memory-embedding-store.ts";

export const MEMORY_EMBEDDING_EVENT = "repository.memory_embedding.requested";
export const MEMORY_EMBEDDING_FUNCTION_ID = "memory-embedding";
/** Bump to re-embed every row through the normal hash path after changing `buildEmbeddingInput`. */
export const EMBEDDING_INPUT_VERSION = "embed-1";
export const MAX_EMBEDDING_INPUT_CHARS = 8_000;
export const EMBEDDING_BATCH_SIZE = 64;
const FN = "inngest";

export const memoryEmbeddingEventSchema = z.object({
  workspace_id: z.uuid(),
  job_id: z.uuid(),
  commit_sha: gitCommitShaSchema,
});

export type MemoryEmbeddingEvent = z.infer<typeof memoryEmbeddingEventSchema>;

export const memoryEmbeddingErrorCodeSchema = z.enum([
  "repository_memory_unavailable",
  "ai_rate_limited",
  "ai_unavailable",
  "ai_invalid_output",
  "embedding_dimension_mismatch",
  "internal_error",
]);

export type MemoryEmbeddingErrorCode = z.infer<typeof memoryEmbeddingErrorCodeSchema>;

export interface MemoryEmbeddingDeps {
  embedding: EmbeddingProvider;
  model: string;
  store: MemoryEmbeddingStore;
  log?: (line: string) => void;
}

export interface BatchResult {
  embedded: number;
  /** Rows whose content changed while the batch ran; the run that the change triggers covers them. */
  superseded: number;
  /** Rows already current when the batch reloaded them (a retried step after a partial write). */
  current: number;
}

export type MemoryEmbeddingRunResult =
  | { outcome: "embedded" } & BatchResult
  | { outcome: "skipped"; reason: "up_to_date" };

interface PendingRow {
  id: string;
  input_hash: string;
}

function logLine(log: ((line: string) => void) | undefined, entry: Record<string, string | number | boolean>): void {
  (log ?? console.log)(JSON.stringify({ fn: FN, ...entry }));
}

/** Errors carry only a fixed code as their message, since Inngest serializes them. */
function nonRetriable(code: MemoryEmbeddingErrorCode): NonRetriableError {
  return new NonRetriableError(code);
}

export function classifyMemoryEmbeddingError(err: unknown): Error {
  if (err instanceof NonRetriableError || err instanceof RetryAfterError) {
    return err;
  }
  if (err instanceof AIRateLimitedError) {
    return new RetryAfterError("ai_rate_limited", err.retryAfterSeconds * 1000);
  }
  if (err instanceof AIUnavailableError) {
    return new Error("ai_unavailable");
  }
  if (err instanceof AIInvalidOutputError) {
    return err.reason === "dimension_mismatch" ? nonRetriable("embedding_dimension_mismatch") : new Error("ai_invalid_output");
  }
  if (err instanceof AIRequestError) {
    return nonRetriable("internal_error");
  }
  return new Error("internal_error");
}

export function memoryEmbeddingFailureCode(err: unknown): MemoryEmbeddingErrorCode {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const parsed = memoryEmbeddingErrorCodeSchema.safeParse(message);
  return parsed.success ? parsed.data : "internal_error";
}

async function classified<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw classifyMemoryEmbeddingError(err);
  }
}

/**
 * The text embedded for a row: its kind and canonical `content`. `structured` (including
 * `structured.ai`) is never embedded, so it can change without invalidating the embedding.
 */
export function buildEmbeddingInput(row: { kind: string; content: string }): string {
  return scrubSecrets(`${row.kind}\n${row.content}`).slice(0, MAX_EMBEDDING_INPUT_CHARS);
}

/** Identifies what an embedding was computed from; a different model or input version re-embeds. */
export async function embeddingInputHash(model: string, row: { kind: string; content: string }): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([model, EMBEDDING_INPUT_VERSION, row.kind, row.content]));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function storedHash(row: EmbeddingMemoryRow): string | null {
  const marker = row.metadata.embedding as Partial<EmbeddingMarker> | undefined;
  return typeof marker?.input_hash === "string" ? marker.input_hash : null;
}

function isCurrent(row: EmbeddingMemoryRow, hash: string): boolean {
  return row.has_embedding && storedHash(row) === hash;
}

function marker(model: string, inputHash: string): EmbeddingMarker {
  return {
    model,
    dimensions: REPOSITORY_MEMORY_EMBEDDING_DIMENSIONS,
    input_hash: inputHash,
    input_version: EMBEDDING_INPUT_VERSION,
    embedded_at: new Date().toISOString(),
  };
}

/** Rows with content whose embedding is missing or was computed from a different input. */
export async function pendingRows(model: string, rows: EmbeddingMemoryRow[]): Promise<PendingRow[]> {
  const pending: PendingRow[] = [];
  for (const row of rows) {
    if (row.content.trim().length === 0) {
      continue;
    }
    const hash = await embeddingInputHash(model, row);
    if (!isCurrent(row, hash)) {
      pending.push({ id: row.id, input_hash: hash });
    }
  }
  return pending;
}

/**
 * Compare-and-set write. On a miss the row is reloaded once: if its content still hashes the same
 * (only `structured` or `metadata` changed) the write is retried with the fresh metadata and the
 * vector already computed; otherwise, or on a second miss, the row is superseded.
 */
async function writeRow(
  deps: MemoryEmbeddingDeps,
  event: MemoryEmbeddingEvent,
  row: EmbeddingMemoryRow,
  inputHash: string,
  vector: number[],
): Promise<boolean> {
  const write = (current: EmbeddingMemoryRow) =>
    deps.store.writeEmbedding(event.workspace_id, current.id, current.updated_at, vector, {
      ...current.metadata,
      embedding: marker(deps.model, inputHash),
    });
  if (await write(row)) {
    return true;
  }
  const [fresh] = await deps.store.loadRows(event.workspace_id, event.commit_sha, [row.id]);
  if (!fresh || await embeddingInputHash(deps.model, fresh) !== inputHash) {
    return false;
  }
  return await write(fresh);
}

async function embedBatch(
  deps: MemoryEmbeddingDeps,
  event: MemoryEmbeddingEvent,
  { userId, runId, batch, pending }: { userId: string; runId: string; batch: number; pending: PendingRow[] },
): Promise<BatchResult> {
  const reloaded = await deps.store.loadRows(event.workspace_id, event.commit_sha, pending.map((p) => p.id));
  const todo: { row: EmbeddingMemoryRow; hash: string }[] = [];
  let current = 0;
  let superseded = 0;
  for (const p of pending) {
    const row = reloaded.find((r) => r.id === p.id);
    if (!row || row.content.trim().length === 0) {
      superseded++;
      continue;
    }
    const hash = await embeddingInputHash(deps.model, row);
    if (isCurrent(row, hash)) {
      current++;
    } else {
      todo.push({ row, hash });
    }
  }
  if (todo.length === 0) {
    return { embedded: 0, superseded, current };
  }

  const { embeddings, usage } = await deps.embedding.embed({
    model: deps.model,
    input: todo.map(({ row }) => buildEmbeddingInput(row)),
  });
  // Recorded before validation: invalid output is still spend. Keyed per call: a retried step
  // calls the provider again, which is a real second spend.
  await deps.store.recordAiUsage({
    userId,
    workspaceId: event.workspace_id,
    interviewId: null,
    task: "embedding",
    model: deps.model,
    source: "provider",
    tokens: { input_tokens: usage.input_tokens },
    idempotencyKey: `embedding:${event.job_id}:${runId}:${batch}:${crypto.randomUUID()}`,
  });
  if (embeddings.length !== todo.length) {
    throw new AIInvalidOutputError("malformed");
  }
  assertEmbeddingDimensions(embeddings, REPOSITORY_MEMORY_EMBEDDING_DIMENSIONS);

  let embedded = 0;
  for (const [i, { row, hash }] of todo.entries()) {
    if (await writeRow(deps, event, row, hash, embeddings[i])) {
      embedded++;
    } else {
      superseded++;
    }
  }
  return { embedded, superseded, current };
}

export async function runMemoryEmbedding(
  deps: MemoryEmbeddingDeps,
  { data, runId, step }: { data: unknown; runId: string; step: StepRunner },
): Promise<MemoryEmbeddingRunResult> {
  const parsed = memoryEmbeddingEventSchema.safeParse(data);
  if (!parsed.success) {
    logLine(deps.log, { event: "memory_embedding_invalid_event", code: "internal_error" });
    throw nonRetriable("internal_error");
  }
  const event = parsed.data;
  const ids = { workspace_id: event.workspace_id, job_id: event.job_id };

  // Only rows of the requested commit: never falls back to another commit's memory.
  const target = await step.run("verify", () =>
    classified(async () => {
      const userId = await deps.store.loadWorkspaceUser(event.workspace_id);
      if (!userId) {
        throw nonRetriable("internal_error");
      }
      const rows = await deps.store.loadRows(event.workspace_id, event.commit_sha);
      if (rows.length === 0) {
        throw nonRetriable("repository_memory_unavailable");
      }
      return { user_id: userId, rows };
    }));

  const pending = await step.run("plan", () => classified(() => pendingRows(deps.model, target.rows)));
  if (pending.length === 0) {
    logLine(deps.log, { event: "memory_embedding_skipped", reason: "up_to_date", ...ids });
    return { outcome: "skipped", reason: "up_to_date" };
  }

  const totals: BatchResult = { embedded: 0, superseded: 0, current: 0 };
  for (let start = 0, batch = 0; start < pending.length; start += EMBEDDING_BATCH_SIZE, batch++) {
    const slice = pending.slice(start, start + EMBEDDING_BATCH_SIZE);
    const result = await step.run(`embed-batch-${batch}`, () =>
      classified(() => embedBatch(deps, event, { userId: target.user_id, runId, batch, pending: slice })));
    totals.embedded += result.embedded;
    totals.superseded += result.superseded;
    totals.current += result.current;
  }

  logLine(deps.log, { event: "memory_embedding_completed", ...ids, model: deps.model, pending: pending.length, ...totals });
  return { outcome: "embedded", ...totals };
}

/**
 * Runs once retries are exhausted (or on a non-retriable error). There is no job row to fail and
 * memory is untouched; search keeps working with keyword results. The Inngest Sentry middleware
 * reports the final failure.
 */
export function handleMemoryEmbeddingFailure(
  deps: Pick<MemoryEmbeddingDeps, "log">,
  { data, error }: { data: unknown; error: unknown },
): void {
  const parsed = memoryEmbeddingEventSchema.safeParse(data);
  const code = memoryEmbeddingFailureCode(error);
  logLine(deps.log, {
    event: "memory_embedding_failed",
    code,
    ...(parsed.success ? { workspace_id: parsed.data.workspace_id, job_id: parsed.data.job_id } : {}),
  });
}

/**
 * Best-effort enqueue of the embedding run, in its own step. Every failure is logged and swallowed
 * inside the step, so it never changes the caller's result and a replay never sends twice.
 */
export async function queueMemoryEmbedding(
  deps: { jobs: JobQueue; log?: (line: string) => void },
  step: StepRunner,
  event: MemoryEmbeddingEvent,
): Promise<void> {
  const ids = { workspace_id: event.workspace_id, job_id: event.job_id };
  await step.run("queue-memory-embedding", async () => {
    try {
      await deps.jobs.enqueue(MEMORY_EMBEDDING_EVENT, event);
      logLine(deps.log, { event: "memory_embedding_queued", ...ids });
      return { queued: true };
    } catch {
      logLine(deps.log, { event: "memory_embedding_enqueue_failed", ...ids });
      return { queued: false };
    }
  });
}

export function createMemoryEmbeddingFunction(inngest: Inngest.Any, deps: MemoryEmbeddingDeps) {
  return inngest.createFunction(
    {
      id: MEMORY_EMBEDDING_FUNCTION_ID,
      name: "Repository memory embedding",
      triggers: [{ event: MEMORY_EMBEDDING_EVENT }],
      idempotency: "event.data.job_id",
      concurrency: { key: "event.data.workspace_id", limit: 1 },
      retries: 3,
      onFailure: ({ event, error }) => handleMemoryEmbeddingFailure(deps, { data: event.data.event.data, error }),
    },
    ({ event, runId, step }) =>
      runMemoryEmbedding(deps, {
        data: event.data,
        runId,
        step: { run: <T>(id: string, fn: () => Promise<T>) => step.run(id, fn) as Promise<T> },
      }),
  );
}
