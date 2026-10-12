import { type CodeParser, createCodeParser, PARSER_VERSION } from "@stackprep/code-parser";
import { gitCommitShaSchema } from "@stackprep/shared";
import { type Inngest, NonRetriableError } from "inngest";
import { z } from "zod";
import { scrubSecrets } from "../_shared/analysis/scrub.ts";
import {
  type CodeFilePayload,
  failedPayload,
  type FileOutline,
  hydratePayload,
  skippedPayload,
  toFilePayload,
  toOutline,
} from "../_shared/code-index/mapper.ts";
import { batchEdgePayloads, type CodeLinkFile, linkFiles, type LinkSummary } from "../_shared/code-index/link.ts";
import { buildCodeMemory } from "../_shared/code-index/memory.ts";
import {
  type CodeIndexFile,
  type CodeIndexLimits,
  DEFAULT_CODE_INDEX_LIMITS,
  planBatches,
  selectCodeFiles,
} from "../_shared/code-index/select.ts";
import { type GithubApp, GithubUnexpectedResponseError } from "../_shared/github-app.ts";
import type { JobQueue } from "../_shared/jobs.ts";
import type { CodeIndexStore, CodeIndexTarget } from "./code-index-store.ts";
import { classifyAnalysisError, type StepRunner } from "./function.ts";
import { queueMemoryEmbedding } from "./memory-embedding.ts";

export const CODE_INDEX_EVENT = "repository.code_index.requested";
export const CODE_INDEX_FUNCTION_ID = "code-index";
const FN = "inngest";
const FETCH_CONCURRENCY = 5;
/** Progress share of the parse batches, between selection (10) and linking (85). */
const BATCH_PROGRESS = { start: 10, end: 85 };
const LINK_PAGE_SIZE = 200;

export const codeIndexEventSchema = z.object({
  workspace_id: z.uuid(),
  job_id: z.uuid(),
  commit_sha: gitCommitShaSchema,
});

export type CodeIndexEvent = z.infer<typeof codeIndexEventSchema>;

export const codeIndexErrorCodeSchema = z.enum([
  "installation_unavailable",
  "repository_unavailable",
  "github_rate_limited",
  "github_unavailable",
  "github_unexpected_response",
  "enqueue_failed",
  "internal_error",
]);

export type CodeIndexErrorCode = z.infer<typeof codeIndexErrorCodeSchema>;

/** Stored on the job; shown to nobody but kept free of upstream details. */
export const CODE_INDEX_FAILURE_MESSAGES: Record<CodeIndexErrorCode, string> = {
  installation_unavailable: "The GitHub App installation is suspended or no longer accessible",
  repository_unavailable: "The repository or commit is no longer accessible",
  github_rate_limited: "GitHub rate limit exceeded",
  github_unavailable: "GitHub is unavailable",
  github_unexpected_response: "Unexpected response from GitHub",
  enqueue_failed: "Code indexing could not be queued",
  internal_error: "Code indexing failed",
};

export interface CodeIndexDeps {
  github: Pick<GithubApp, "getRepositoryTree" | "getBlob">;
  store: CodeIndexStore;
  /** Sends the best-effort memory embedding that follows a successful index. */
  jobs: JobQueue;
  /** Shared across runs in one isolate so grammars load once; created lazily by default. */
  parser?: CodeParser;
  limits?: CodeIndexLimits;
  log?: (line: string) => void;
}

export interface CodeIndexBatchResult {
  written: number;
  /** Files whose facts were reused from another commit instead of being fetched and parsed. */
  reused: number;
  counts: Record<CodeFilePayload["parse_status"], number>;
  outlines: FileOutline[];
}

export type CodeIndexRunResult =
  | { outcome: "indexed"; files: number; memory_rows: number }
  | { outcome: "skipped"; reason: "already_succeeded" };

let sharedParser: CodeParser | null = null;

function parserFor(deps: CodeIndexDeps): CodeParser {
  if (deps.parser) {
    return deps.parser;
  }
  sharedParser ??= createCodeParser();
  return sharedParser;
}

function logLine(deps: Pick<CodeIndexDeps, "log">, entry: Record<string, string | number | boolean>): void {
  (deps.log ?? console.log)(JSON.stringify({ fn: FN, ...entry }));
}

function nonRetriable(code: CodeIndexErrorCode): NonRetriableError {
  return new NonRetriableError(code);
}

export function codeIndexFailureCode(err: unknown): CodeIndexErrorCode {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const parsed = codeIndexErrorCodeSchema.safeParse(message);
  return parsed.success ? parsed.data : "internal_error";
}

async function classified<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    // GitHub failures map exactly like the baseline analysis; anything else is a retriable internal error.
    throw classifyAnalysisError(err);
  }
}

/** Re-resolves the job from the database; the event payload is only trusted to match it. */
function verifyTarget(target: CodeIndexTarget | null, event: CodeIndexEvent): CodeIndexTarget & { installation_id: number } {
  if (!target || target.workspace_id !== event.workspace_id || target.commit_sha !== event.commit_sha) {
    throw nonRetriable("internal_error");
  }
  if (target.installation_id === null || target.suspended) {
    throw nonRetriable("installation_unavailable");
  }
  return target as CodeIndexTarget & { installation_id: number };
}

async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function decodeText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) {
    return null;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Fetches and parses one file. Every per-file problem becomes a recorded status so the run goes
 * on; only GitHub failures that affect the whole run (rate limit, outage, lost access) throw.
 */
async function indexFile(
  deps: CodeIndexDeps,
  target: CodeIndexTarget & { installation_id: number },
  file: CodeIndexFile,
  knownPaths: ReadonlySet<string>,
  limits: CodeIndexLimits,
): Promise<CodeFilePayload> {
  if (file.skip) {
    return skippedPayload(file, file.skip);
  }
  let bytes: Uint8Array | null;
  try {
    bytes = await deps.github.getBlob(target.installation_id, target.owner, target.name, file.sha, limits.maxFileBytes);
  } catch (err) {
    if (err instanceof GithubUnexpectedResponseError) {
      return skippedPayload(file, "fetch_failed");
    }
    throw err;
  }
  if (bytes === null) {
    return skippedPayload(file, "too_large");
  }
  const text = decodeText(bytes);
  if (text === null) {
    return skippedPayload(file, "not_utf8");
  }
  // Facts of secret-bearing files would carry names next to the secret; the file is skipped whole.
  if (scrubSecrets(text) !== text) {
    return skippedPayload(file, "secret");
  }
  try {
    const parser = parserFor(deps);
    const language = parser.detectLanguage(file.path, text) ?? file.language;
    const facts = await parser.parseFile({ content: text, language, path: file.path, limits: { maxBytes: limits.maxFileBytes } });
    return toFilePayload(file, facts, bytes.length, knownPaths);
  } catch {
    // parseFile reports bad input as data; this only guards against a defect in the mapping.
    return failedPayload(file, bytes.length, "internal_error");
  }
}

/**
 * Payloads for one batch. Files whose blob was already indexed at another commit (same path and
 * parser version) are rebuilt from stored facts; only the rest are fetched and parsed.
 */
async function indexBatch(
  deps: CodeIndexDeps,
  target: CodeIndexTarget & { installation_id: number },
  batch: CodeIndexFile[],
  knownPaths: ReadonlySet<string>,
  limits: CodeIndexLimits,
): Promise<{ payloads: CodeFilePayload[]; reused: number }> {
  const lookups = batch.filter((f) => !f.skip).map((f) => ({ path: f.path, blob_sha: f.sha }));
  const stored = lookups.length > 0 ? await deps.store.loadReusable(target.workspace_id, PARSER_VERSION, lookups) : [];
  const reusable = new Map(stored.map((p) => [p.path, p]));
  let reused = 0;
  const payloads = await mapLimited(batch, FETCH_CONCURRENCY, (file) => {
    const hit = file.skip ? undefined : reusable.get(file.path);
    if (hit && hit.blob_sha === file.sha) {
      reused++;
      return Promise.resolve(hydratePayload(hit, knownPaths));
    }
    return indexFile(deps, target, file, knownPaths, limits);
  });
  return { payloads, reused };
}

function emptyCounts(): CodeIndexBatchResult["counts"] {
  return { ok: 0, partial: 0, failed: 0, unsupported: 0, skipped: 0 };
}

/**
 * Best-effort pruning of other commits' index. Failures are logged and swallowed inside the step:
 * stale facts only cost storage, never correctness, since every read is pinned to a commit.
 */
async function pruneOtherCommits(deps: CodeIndexDeps, step: StepRunner, event: CodeIndexEvent): Promise<void> {
  const ids = { workspace_id: event.workspace_id, job_id: event.job_id };
  await step.run("prune", async () => {
    try {
      const retained = await deps.store.listRetainedCommits(event.workspace_id);
      const keep = [...new Set([event.commit_sha, ...retained])].sort();
      const deleted = await deps.store.prune(event.workspace_id, keep);
      logLine(deps, { event: "code_index_pruned", ...ids, deleted, kept_commits: keep.length });
      return { deleted };
    } catch {
      logLine(deps, { event: "code_index_prune_failed", ...ids });
      return { deleted: 0 };
    }
  });
}

/**
 * Best-effort cross-file call graph over everything the batches stored for the commit. Failures
 * are logged and swallowed: without edges, `find_callers` still answers by name.
 */
async function linkCallGraph(
  deps: CodeIndexDeps,
  step: StepRunner,
  event: CodeIndexEvent,
  knownPaths: string[],
  runId: string,
): Promise<LinkSummary | null> {
  const ids = { workspace_id: event.workspace_id, job_id: event.job_id };
  return await step.run("link", async () => {
    try {
      await deps.store.markStage(event.job_id, BATCH_PROGRESS.end, runId);
      const files: CodeLinkFile[] = [];
      let after: string | null = null;
      for (;;) {
        const page = await deps.store.loadLinkFacts(event.workspace_id, event.commit_sha, after, LINK_PAGE_SIZE);
        if (page.length === 0) {
          break;
        }
        files.push(...page);
        after = page[page.length - 1].path;
      }
      const { payloads, summary } = linkFiles(files, knownPaths);
      let edges = 0;
      for (const batch of batchEdgePayloads(payloads)) {
        edges += await deps.store.replaceEdges(event.workspace_id, event.commit_sha, batch);
      }
      logLine(deps, {
        event: "code_index_linked",
        ...ids,
        files: summary.files,
        edges,
        edges_resolved: summary.edges_resolved,
        edges_ambiguous: summary.edges_ambiguous,
        calls_unresolved: summary.calls_unresolved,
        limits_hit: summary.limits_hit.join(",") || "none",
      });
      return summary;
    } catch {
      logLine(deps, { event: "code_index_link_failed", ...ids });
      return null;
    }
  });
}

export async function runCodeIndex(
  deps: CodeIndexDeps,
  { data, runId, step }: { data: unknown; runId: string; step: StepRunner },
): Promise<CodeIndexRunResult> {
  const parsed = codeIndexEventSchema.safeParse(data);
  if (!parsed.success) {
    logLine(deps, { event: "code_index_invalid_event", code: "internal_error" });
    throw nonRetriable("internal_error");
  }
  const event = parsed.data;
  const ids = { workspace_id: event.workspace_id, job_id: event.job_id };
  const limits = deps.limits ?? DEFAULT_CODE_INDEX_LIMITS;

  const target = await step.run("verify", () =>
    classified(async () => verifyTarget(await deps.store.loadTarget(event.job_id, event.workspace_id), event)));
  if (target.job_status === "succeeded") {
    logLine(deps, { event: "code_index_skipped", reason: "already_succeeded", ...ids });
    return { outcome: "skipped", reason: "already_succeeded" };
  }

  const selection = await step.run("select", () =>
    classified(async () => {
      await deps.store.markStage(event.job_id, BATCH_PROGRESS.start, runId);
      const tree = await deps.github.getRepositoryTree(target.installation_id, target.owner, target.name, event.commit_sha);
      const parser = parserFor(deps);
      return selectCodeFiles(tree.entries, tree.truncated, (path) => parser.detectLanguage(path), limits);
    }));

  const knownPaths = new Set(selection.known_paths);
  const batches = planBatches(selection.files, limits);
  const totals = emptyCounts();
  const outlines: FileOutline[] = [];
  let written = 0;
  let reused = 0;
  for (const [index, batch] of batches.entries()) {
    const result: CodeIndexBatchResult = await step.run(`index-batch-${index}`, () =>
      classified(async () => {
        const progress = BATCH_PROGRESS.start +
          Math.floor(((BATCH_PROGRESS.end - BATCH_PROGRESS.start) * index) / Math.max(batches.length, 1));
        await deps.store.markStage(event.job_id, progress, runId);
        const { payloads, reused: reusedNow } = await indexBatch(deps, target, batch, knownPaths, limits);
        const writtenNow = await deps.store.replaceFiles(event.workspace_id, event.commit_sha, PARSER_VERSION, payloads);
        const counts = emptyCounts();
        for (const p of payloads) {
          counts[p.parse_status]++;
        }
        return {
          written: writtenNow,
          reused: reusedNow,
          counts,
          outlines: payloads.map(toOutline).filter((o): o is FileOutline => o !== null),
        };
      }));
    written += result.written;
    reused += result.reused;
    outlines.push(...result.outlines);
    for (const [status, n] of Object.entries(result.counts) as [keyof typeof totals, number][]) {
      totals[status] += n;
    }
  }

  const link = await linkCallGraph(deps, step, event, selection.known_paths, runId);

  const memoryRows = await step.run("save-memory", () =>
    classified(async () => {
      await deps.store.markStage(event.job_id, 90, runId);
      const rows = buildCodeMemory(outlines, { commitSha: event.commit_sha, parserVersion: PARSER_VERSION });
      await deps.store.saveMemory(event.workspace_id, event.job_id, event.commit_sha, rows);
      return rows.length;
    }));

  await step.run("complete", () =>
    classified(() =>
      deps.store.complete(event.workspace_id, event.job_id, event.commit_sha, PARSER_VERSION, {
        limits_hit: selection.limits_hit,
        selection: { candidates: selection.candidates, selected: selection.files.length, batches: batches.length, reused },
        limits: { max_files: limits.maxFiles, max_file_bytes: limits.maxFileBytes, max_total_bytes: limits.maxTotalBytes },
        link: link
          ? {
            edges_resolved: link.edges_resolved,
            edges_ambiguous: link.edges_ambiguous,
            calls_unresolved: link.calls_unresolved,
            limits_hit: link.limits_hit,
          }
          : null,
      })
    ));
  await pruneOtherCommits(deps, step, event);
  // New or rewritten code_module and file_summary rows; unchanged rows are skipped by their hash.
  await queueMemoryEmbedding(deps, step, event);

  logLine(deps, {
    event: "code_index_completed",
    ...ids,
    candidates: selection.candidates,
    files: selection.files.length,
    batches: batches.length,
    written,
    reused,
    ...totals,
    memory_rows: memoryRows,
    limits_hit: selection.limits_hit.join(",") || "none",
    linked: link !== null,
  });
  return { outcome: "indexed", files: selection.files.length, memory_rows: memoryRows };
}

/** Runs once retries are exhausted (or on a non-retriable error): records a fixed code. */
export async function handleCodeIndexFailure(
  deps: Pick<CodeIndexDeps, "store" | "log">,
  { data, error }: { data: unknown; error: unknown },
): Promise<void> {
  const parsed = codeIndexEventSchema.safeParse(data);
  const code = codeIndexFailureCode(error);
  if (!parsed.success) {
    logLine(deps, { event: "code_index_failed", code, recorded: false });
    return;
  }
  const { workspace_id, job_id } = parsed.data;
  await deps.store.fail(workspace_id, job_id, code, CODE_INDEX_FAILURE_MESSAGES[code]);
  logLine(deps, { event: "code_index_failed", code, workspace_id, job_id, recorded: true });
}

export function createCodeIndexFunction(inngest: Inngest.Any, deps: CodeIndexDeps) {
  return inngest.createFunction(
    {
      id: CODE_INDEX_FUNCTION_ID,
      name: "Repository code index",
      triggers: [{ event: CODE_INDEX_EVENT }],
      idempotency: "event.data.job_id",
      concurrency: { key: "event.data.workspace_id", limit: 1 },
      retries: 4,
      onFailure: ({ event, error }) => handleCodeIndexFailure(deps, { data: event.data.event.data, error }),
    },
    ({ event, runId, step }) =>
      runCodeIndex(deps, {
        data: event.data,
        runId,
        step: { run: <T>(id: string, fn: () => Promise<T>) => step.run(id, fn) as Promise<T> },
      }),
  );
}
