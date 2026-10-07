import { PARSER_VERSION } from "@stackprep/code-parser";
import { type AnalysisErrorCode, analysisErrorCodeSchema, gitCommitShaSchema } from "@stackprep/shared";
import { type Inngest, NonRetriableError, RetryAfterError } from "inngest";
import { z } from "zod";
import { buildRepositoryContext, type FileFacts, extractFileFacts, type MemoryRow } from "../_shared/analysis/context.ts";
import { type AnalysisLimits, DEFAULT_ANALYSIS_LIMITS, scanTree, type TreeScan } from "../_shared/analysis/filter.ts";
import {
  type GithubApp,
  GithubError,
  GithubForbiddenError,
  GithubNotFoundError,
  GithubRateLimitedError,
  GithubUnavailableError,
} from "../_shared/github-app.ts";
import type { JobQueue } from "../_shared/jobs.ts";
import { CODE_INDEX_EVENT, CODE_INDEX_FAILURE_MESSAGES } from "./code-index.ts";
import { DEEP_ANALYSIS_EVENT, DEEP_ANALYSIS_FAILURE_MESSAGES } from "./deep-analysis.ts";
import { queueMemoryEmbedding } from "./memory-embedding.ts";
import type { AnalysisStore, AnalysisTarget } from "./store.ts";

export const ANALYSIS_EVENT = "repository.analysis.requested";
export const ANALYSIS_FUNCTION_ID = "repository-analysis";
const FN = "inngest";
const FETCH_CONCURRENCY = 5;

export const analysisEventSchema = z.object({
  workspace_id: z.uuid(),
  repository_id: z.uuid(),
  job_id: z.uuid(),
  installation_id: z.int().min(1),
  commit_sha: gitCommitShaSchema,
});

export type AnalysisEvent = z.infer<typeof analysisEventSchema>;

/** Stored on the job; shown to nobody but kept free of upstream details. */
export const FAILURE_MESSAGES: Record<AnalysisErrorCode, string> = {
  installation_unavailable: "The GitHub App installation is suspended or no longer accessible",
  repository_unavailable: "The repository or commit is no longer accessible",
  github_rate_limited: "GitHub rate limit exceeded",
  github_unavailable: "GitHub is unavailable",
  github_unexpected_response: "Unexpected response from GitHub",
  enqueue_failed: "The analysis could not be queued",
  internal_error: "Repository analysis failed",
};

export interface AnalysisDeps {
  github: Pick<GithubApp, "getRepositoryTree" | "getBlob">;
  store: AnalysisStore;
  /** Sends the best-effort deep analysis and memory embedding that follow a successful baseline. */
  jobs: JobQueue;
  limits?: AnalysisLimits;
  log?: (line: string) => void;
}

/** Minimal durable-step surface, so the run can be exercised without Inngest. */
export interface StepRunner {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
}

export type AnalysisResult =
  | { outcome: "completed"; ready: boolean; memory_rows: number }
  | { outcome: "skipped"; reason: "already_succeeded" | "memory_exists"; ready: boolean };

function logLine(deps: AnalysisDeps, entry: Record<string, string | number | boolean>): void {
  (deps.log ?? console.log)(JSON.stringify({ fn: FN, ...entry }));
}

/** Errors carry only a fixed code as their message, since Inngest serializes them. */
function nonRetriable(code: AnalysisErrorCode): NonRetriableError {
  return new NonRetriableError(code);
}

/** Maps a failure to a fixed code and whether a retry could help. */
export function classifyAnalysisError(err: unknown): Error {
  if (err instanceof NonRetriableError || err instanceof RetryAfterError) {
    return err;
  }
  if (err instanceof GithubForbiddenError || err instanceof GithubNotFoundError) {
    return nonRetriable("installation_unavailable");
  }
  if (err instanceof GithubRateLimitedError) {
    return new RetryAfterError("github_rate_limited", err.retryAfterSeconds * 1000);
  }
  if (err instanceof GithubUnavailableError) {
    return new Error("github_unavailable");
  }
  if (err instanceof GithubError) {
    return err.status === 403 || err.status === 404 || err.status === 409 || err.status === 422
      ? nonRetriable("repository_unavailable")
      : new Error("github_unexpected_response");
  }
  return new Error("internal_error");
}

export function failureCode(err: unknown): AnalysisErrorCode {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const parsed = analysisErrorCodeSchema.safeParse(message);
  return parsed.success ? parsed.data : "internal_error";
}

async function classified<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw classifyAnalysisError(err);
  }
}

/** Re-resolves everything from the database; the event payload is only trusted to match it. */
function verifyTarget(target: AnalysisTarget | null, event: AnalysisEvent): AnalysisTarget & { installation_id: number } {
  if (!target || target.repository_id !== event.repository_id || target.workspace_id !== event.workspace_id) {
    throw nonRetriable("internal_error");
  }
  if (target.target_commit_sha !== event.commit_sha ||
    (target.job_commit_sha !== null && target.job_commit_sha !== event.commit_sha)) {
    throw nonRetriable("internal_error");
  }
  if (target.installation_id === null || target.installation_id !== event.installation_id || target.suspended) {
    throw nonRetriable("installation_unavailable");
  }
  return target as AnalysisTarget & { installation_id: number };
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

/**
 * Best-effort enqueue of deep analysis, in its own step after the baseline is complete. Every
 * failure is logged and swallowed inside the step, so it never changes the baseline result and a
 * replay never queues a second job.
 */
async function queueDeepAnalysis(deps: AnalysisDeps, step: StepRunner, event: AnalysisEvent): Promise<void> {
  const ids = { workspace_id: event.workspace_id, analysis_job_id: event.job_id };
  await step.run("queue-deep-analysis", async () => {
    let jobId: string | null = null;
    try {
      jobId = await deps.store.requestDeepAnalysis(event.workspace_id, event.commit_sha);
      if (jobId === null) {
        return { queued: false };
      }
      await deps.jobs.enqueue(DEEP_ANALYSIS_EVENT, {
        workspace_id: event.workspace_id,
        job_id: jobId,
        commit_sha: event.commit_sha,
      });
      logLine(deps, { event: "deep_analysis_queued", ...ids, job_id: jobId });
      return { queued: true };
    } catch {
      if (jobId !== null) {
        try {
          await deps.store.failDeepAnalysis(event.workspace_id, jobId, "enqueue_failed", DEEP_ANALYSIS_FAILURE_MESSAGES.enqueue_failed);
        } catch {
          // The job is left queued and blocks further deep analysis for the workspace until cleared.
        }
      }
      logLine(deps, { event: "deep_analysis_enqueue_failed", ...ids, ...(jobId ? { job_id: jobId } : {}) });
      return { queued: false };
    }
  });
}

/**
 * Best-effort enqueue of the code index, in its own step after the baseline is complete. Like the
 * deep analysis enqueue, every failure is logged and swallowed, so it never changes readiness.
 */
async function queueCodeIndex(deps: AnalysisDeps, step: StepRunner, event: AnalysisEvent): Promise<void> {
  const ids = { workspace_id: event.workspace_id, analysis_job_id: event.job_id };
  await step.run("queue-code-index", async () => {
    let jobId: string | null = null;
    try {
      jobId = await deps.store.requestCodeIndex(event.workspace_id, event.commit_sha, PARSER_VERSION);
      if (jobId === null) {
        return { queued: false };
      }
      await deps.jobs.enqueue(CODE_INDEX_EVENT, {
        workspace_id: event.workspace_id,
        job_id: jobId,
        commit_sha: event.commit_sha,
      });
      logLine(deps, { event: "code_index_queued", ...ids, job_id: jobId });
      return { queued: true };
    } catch {
      if (jobId !== null) {
        try {
          await deps.store.failCodeIndex(event.workspace_id, jobId, "enqueue_failed", CODE_INDEX_FAILURE_MESSAGES.enqueue_failed);
        } catch {
          // The job is left queued and blocks further code indexing for the workspace until cleared.
        }
      }
      logLine(deps, { event: "code_index_enqueue_failed", ...ids, ...(jobId ? { job_id: jobId } : {}) });
      return { queued: false };
    }
  });
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

export async function runRepositoryAnalysis(
  deps: AnalysisDeps,
  { data, runId, step }: { data: unknown; runId: string; step: StepRunner },
): Promise<AnalysisResult> {
  const parsed = analysisEventSchema.safeParse(data);
  if (!parsed.success) {
    logLine(deps, { event: "analysis_invalid_event", code: "internal_error" });
    throw nonRetriable("internal_error");
  }
  const event = parsed.data;
  const ids = { workspace_id: event.workspace_id, job_id: event.job_id };
  const limits = deps.limits ?? DEFAULT_ANALYSIS_LIMITS;

  const target = await step.run("verify", () =>
    classified(async () => verifyTarget(await deps.store.loadTarget(event.job_id, event.workspace_id), event)));
  const { owner, name, installation_id: installationId } = target;

  if (target.job_status === "succeeded") {
    logLine(deps, { event: "analysis_skipped", reason: "already_succeeded", ...ids });
    return { outcome: "skipped", reason: "already_succeeded", ready: true };
  }

  const existing = await step.run("check-existing", () =>
    classified(() => deps.store.countMemory(event.workspace_id, event.commit_sha)));
  if (existing > 0) {
    const ready = await step.run("complete", () =>
      classified(() => deps.store.complete(event.workspace_id, event.job_id, event.commit_sha, [])));
    logLine(deps, { event: "analysis_skipped", reason: "memory_exists", ...ids });
    if (ready) {
      await queueDeepAnalysis(deps, step, event);
      await queueCodeIndex(deps, step, event);
      await queueMemoryEmbedding(deps, step, { workspace_id: event.workspace_id, job_id: event.job_id, commit_sha: event.commit_sha });
    }
    return { outcome: "skipped", reason: "memory_exists", ready };
  }

  const scan: TreeScan = await step.run("scanning", () =>
    classified(async () => {
      await deps.store.markStage(event.job_id, "scanning", 10, runId);
      const tree = await deps.github.getRepositoryTree(installationId, owner, name, event.commit_sha);
      return scanTree(tree.entries, tree.truncated, limits);
    }));

  const analyzed = await step.run("analyzing", () =>
    classified(async () => {
      await deps.store.markStage(event.job_id, "analyzing", 40, runId);
      const results = await mapLimited(scan.selected, FETCH_CONCURRENCY, async (file) => {
        const bytes = await deps.github.getBlob(installationId, owner, name, file.sha, limits.maxFileBytes);
        const text = bytes ? decodeText(bytes) : null;
        return text === null ? null : extractFileFacts(file.path, text);
      });
      const files = results.filter((r): r is FileFacts => r !== null);
      return { files, skipped: results.length - files.length };
    }));

  const memory: MemoryRow[] = await step.run("preparing_context", () =>
    classified(async () => {
      await deps.store.markStage(event.job_id, "preparing_context", 80, runId);
      return buildRepositoryContext({
        commitSha: event.commit_sha,
        stats: scan.stats,
        limitsHit: scan.limits_hit,
        files: analyzed.files,
        skippedFiles: analyzed.skipped,
      });
    }));

  const ready = await step.run("complete", () =>
    classified(() => deps.store.complete(event.workspace_id, event.job_id, event.commit_sha, memory)));

  logLine(deps, {
    event: "analysis_completed",
    ...ids,
    ready,
    files: scan.stats.files,
    selected: scan.selected.length,
    analyzed: analyzed.files.length,
    skipped: analyzed.skipped,
    memory_rows: memory.length,
    limits_hit: scan.limits_hit.join(",") || "none",
  });
  if (ready) {
    await queueDeepAnalysis(deps, step, event);
    await queueCodeIndex(deps, step, event);
    await queueMemoryEmbedding(deps, step, { workspace_id: event.workspace_id, job_id: event.job_id, commit_sha: event.commit_sha });
  }
  return { outcome: "completed", ready, memory_rows: memory.length };
}

/** Runs once retries are exhausted (or on a non-retriable error): records a fixed code. */
export async function handleAnalysisFailure(
  deps: AnalysisDeps,
  { data, error }: { data: unknown; error: unknown },
): Promise<void> {
  const parsed = analysisEventSchema.safeParse(data);
  const code = failureCode(error);
  if (!parsed.success) {
    logLine(deps, { event: "analysis_failed", code, recorded: false });
    return;
  }
  const { workspace_id, job_id } = parsed.data;
  await deps.store.fail(workspace_id, job_id, code, FAILURE_MESSAGES[code]);
  logLine(deps, { event: "analysis_failed", code, workspace_id, job_id, recorded: true });
}

export function createRepositoryAnalysisFunction(inngest: Inngest.Any, deps: AnalysisDeps) {
  return inngest.createFunction(
    {
      id: ANALYSIS_FUNCTION_ID,
      name: "Repository analysis",
      triggers: [{ event: ANALYSIS_EVENT }],
      idempotency: "event.data.job_id",
      concurrency: { key: "event.data.workspace_id", limit: 1 },
      retries: 4,
      onFailure: ({ event, error }) => handleAnalysisFailure(deps, { data: event.data.event.data, error }),
    },
    ({ event, runId, step }) =>
      runRepositoryAnalysis(deps, {
        data: event.data,
        runId,
        step: { run: <T>(id: string, fn: () => Promise<T>) => step.run(id, fn) as Promise<T> },
      }),
  );
}
