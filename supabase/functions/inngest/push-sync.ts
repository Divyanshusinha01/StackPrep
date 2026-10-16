import { type Inngest, NonRetriableError } from "inngest";
import { z } from "zod";
import type { GithubApp } from "../_shared/github-app.ts";
import type { JobQueue } from "../_shared/jobs.ts";
import { ANALYSIS_EVENT, classifyAnalysisError, FAILURE_MESSAGES, type StepRunner } from "./function.ts";
import type { FollowOutcome, PushSyncStore } from "./push-sync-store.ts";

export const PUSH_SYNC_EVENT = "repository.push.received";
export const PUSH_SYNC_FUNCTION_ID = "repository-push-sync";
const FN = "inngest";

/** Attempts per run. Between attempts the run sleeps while another analysis job is active. */
export const MAX_ATTEMPTS = 6;
/** Sleep after attempt i (about 30 minutes in total); the reconciler takes over afterwards. */
export const ATTEMPT_BACKOFFS = ["1m", "2m", "4m", "8m", "15m"] as const;

export const pushSyncEventSchema = z.object({
  workspace_id: z.uuid(),
  installation_id: z.int().min(1),
});

export type PushSyncEvent = z.infer<typeof pushSyncEventSchema>;

export interface PushSyncDeps {
  github: Pick<GithubApp, "getRepositoryHead">;
  store: PushSyncStore;
  /** Sends `repository.analysis.requested` for a followed head. */
  jobs: JobQueue;
  log?: (line: string) => void;
}

export interface PushSyncStepRunner extends StepRunner {
  sleep(id: string, duration: string): Promise<void>;
}

export type PushSyncResult =
  | { outcome: "skipped"; reason: "not_ready" | "installation_unavailable" | "key_unavailable" }
  | { outcome: "up_to_date" }
  | { outcome: "queued"; job_id: string; commit_sha: string }
  | { outcome: "enqueue_failed"; job_id: string }
  | { outcome: "deferred"; attempts: number };

function logLine(deps: PushSyncDeps, entry: Record<string, string | number | boolean>): void {
  (deps.log ?? console.log)(JSON.stringify({ fn: FN, ...entry }));
}

async function classified<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw classifyAnalysisError(err);
  }
}

/**
 * Moves a ready workspace to its default branch head after a push. Each attempt reads the push
 * generation, then resolves the head, then advances, so the synced generation never covers a push
 * newer than the head. A skipped or deferred run leaves the push pending for the reconciler.
 */
export async function runPushSync(
  deps: PushSyncDeps,
  { data, step }: { data: unknown; step: PushSyncStepRunner },
): Promise<PushSyncResult> {
  const parsed = pushSyncEventSchema.safeParse(data);
  if (!parsed.success) {
    logLine(deps, { event: "push_sync_invalid_event", code: "internal_error" });
    throw new NonRetriableError("internal_error");
  }
  const event = parsed.data;
  const ids = { workspace_id: event.workspace_id };

  const verified = await step.run("verify", () =>
    classified(async () => {
      const ws = await deps.store.loadWorkspace(event.workspace_id);
      if (!ws || ws.status !== "ready") {
        return { skip: "not_ready" as const };
      }
      if (ws.installation_id === null || ws.suspended || ws.installation_id !== event.installation_id) {
        return { skip: "installation_unavailable" as const };
      }
      // Following the head queues deep analysis and embeddings, which need the owner's key.
      if (!ws.openai_key_valid) {
        return { skip: "key_unavailable" as const };
      }
      return { skip: null, workspace: { ...ws, installation_id: ws.installation_id } };
    }));
  if (verified.skip !== null) {
    logLine(deps, { event: "push_sync_skipped", reason: verified.skip, ...ids });
    return { outcome: "skipped", reason: verified.skip };
  }
  const ws = verified.workspace;

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const generations = await step.run(`observe-${i}`, () => classified(() => deps.store.readGenerations(event.workspace_id)));
    if (!generations) {
      logLine(deps, { event: "push_sync_skipped", reason: "not_ready", ...ids });
      return { outcome: "skipped", reason: "not_ready" };
    }
    if (generations.push_generation <= generations.synced_generation) {
      logLine(deps, { event: "push_sync_up_to_date", ...ids, attempt: i });
      return { outcome: "up_to_date" };
    }
    const observed = generations.push_generation;

    const head = await step.run(`resolve-head-${i}`, () =>
      classified(() => deps.github.getRepositoryHead(ws.installation_id, ws.owner, ws.name)));

    const advanced = await step.run(`advance-${i}`, () =>
      classified(() => deps.store.followHead(event.workspace_id, head.commitSha, observed)));
    const outcome: FollowOutcome = advanced.outcome;

    if (outcome === "not_ready") {
      logLine(deps, { event: "push_sync_skipped", reason: "not_ready", ...ids });
      return { outcome: "skipped", reason: "not_ready" };
    }
    if (outcome === "up_to_date") {
      logLine(deps, { event: "push_sync_up_to_date", ...ids, attempt: i, generation: observed });
      return { outcome: "up_to_date" };
    }
    if (outcome === "queued" && advanced.job_id !== null) {
      const jobId = advanced.job_id;
      const enqueued = await step.run("enqueue", async () => {
        try {
          await deps.jobs.enqueue(ANALYSIS_EVENT, {
            workspace_id: event.workspace_id,
            repository_id: ws.repository_id,
            job_id: jobId,
            installation_id: ws.installation_id,
            commit_sha: head.commitSha,
          });
          return { ok: true };
        } catch {
          // The workspace stays ready on its indexed commit; reopening keeps the push pending.
          await deps.store.failAnalysis(event.workspace_id, jobId, "enqueue_failed", FAILURE_MESSAGES.enqueue_failed);
          await deps.store.reopen(event.workspace_id, observed);
          return { ok: false };
        }
      });
      if (!enqueued.ok) {
        logLine(deps, { event: "push_sync_enqueue_failed", ...ids, job_id: jobId, generation: observed });
        return { outcome: "enqueue_failed", job_id: jobId };
      }
      logLine(deps, { event: "push_sync_queued", ...ids, job_id: jobId, generation: observed, attempt: i });
      return { outcome: "queued", job_id: jobId, commit_sha: head.commitSha };
    }

    // analysis_active: request_code_index and request_deep_analysis would silently skip a new
    // commit while a previous run is active, so the target only moves once nothing is running.
    if (i < ATTEMPT_BACKOFFS.length) {
      await step.sleep(`wait-${i}`, ATTEMPT_BACKOFFS[i]);
    }
  }

  logLine(deps, { event: "push_sync_deferred", ...ids, attempts: MAX_ATTEMPTS });
  return { outcome: "deferred", attempts: MAX_ATTEMPTS };
}

export function createPushSyncFunction(inngest: Inngest.Any, deps: PushSyncDeps) {
  return inngest.createFunction(
    {
      id: PUSH_SYNC_FUNCTION_ID,
      name: "Repository push sync",
      triggers: [{ event: PUSH_SYNC_EVENT }],
      // A burst of pushes becomes one run, so one baseline, deep analysis and code index.
      debounce: { key: "event.data.workspace_id", period: "2m" },
      concurrency: { key: "event.data.workspace_id", limit: 1 },
      // Only transient GitHub and database errors; waiting for active jobs is the attempt loop.
      retries: 2,
    },
    ({ event, step }) =>
      runPushSync(deps, {
        data: event.data,
        step: {
          run: <T>(id: string, fn: () => Promise<T>) => step.run(id, fn) as Promise<T>,
          sleep: (id, duration) => step.sleep(id, duration),
        },
      }),
  );
}
