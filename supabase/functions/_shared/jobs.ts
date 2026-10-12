export interface JobEvents {
  "repository.analysis.requested": {
    workspace_id: string;
    repository_id: string;
    /** The `jobs` row that projects this run's progress. */
    job_id: string;
    installation_id: number;
    commit_sha: string;
  };
  "repository.deep_analysis.requested": {
    workspace_id: string;
    /** The `deep_analysis` jobs row that projects this run's progress. */
    job_id: string;
    /** The analyzed commit whose memory is enriched. */
    commit_sha: string;
  };
  "repository.code_index.requested": {
    workspace_id: string;
    /** The `code_indexing` jobs row that projects this run's progress. */
    job_id: string;
    /** The analyzed commit whose source files are parsed. */
    commit_sha: string;
  };
  "repository.memory_embedding.requested": {
    workspace_id: string;
    /**
     * The job that triggered the run (baseline analysis, deep analysis or code index). There is no embedding
     * jobs row; the id only keys the event and the run's idempotency.
     */
    job_id: string;
    /** The analyzed commit whose memory rows are embedded. */
    commit_sha: string;
  };
  "interview.planning.requested": {
    interview_id: string;
    workspace_id: string;
    /** The `interview_planning` jobs row that projects this run's progress. */
    job_id: string;
    /** The interview's pinned commit. */
    commit_sha: string;
  };
  "interview.report.requested": {
    interview_id: string;
    workspace_id: string;
    /** The `report_generation` jobs row that projects this run's progress. */
    job_id: string;
  };
  "repository.push.received": {
    workspace_id: string;
    installation_id: number;
    /** `push:<X-GitHub-Delivery>:<workspace_id>` or `reconcile:<workspace_id>:<push_generation>`. */
    dedupe_key: string;
  };
}

export type JobEventName = keyof JobEvents;

export interface EnqueueResult {
  /** Id assigned by the job runner, when it returns one. */
  eventId: string | null;
}

export interface JobQueue {
  enqueue<E extends JobEventName>(name: E, payload: JobEvents[E]): Promise<EnqueueResult>;
}

/** The subset of the Inngest client the queue needs, so domain code never imports the SDK. */
export interface EventSender {
  send(payload: { id?: string; name: string; data: Record<string, unknown> }): Promise<{ ids: string[] }>;
}

function dedupeKey(payload: JobEvents[JobEventName]): string {
  return "job_id" in payload ? payload.job_id : payload.dedupe_key;
}

/**
 * Sends jobs as Inngest events. The event id is derived from the event name and the job id (or the
 * explicit dedupe key of events without a job), so a re-sent event is deduplicated by Inngest
 * instead of starting a second run.
 */
export function createInngestJobQueue(sender: EventSender): JobQueue {
  return {
    async enqueue(name, payload) {
      const { ids } = await sender.send({ id: `${name}:${dedupeKey(payload)}`, name, data: { ...payload } });
      return { eventId: ids[0] ?? null };
    },
  };
}
