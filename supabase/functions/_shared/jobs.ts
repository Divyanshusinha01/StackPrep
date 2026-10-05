export interface JobEvents {
  "repository.analysis.requested": {
    workspace_id: string;
    repository_id: string;
    /** The `jobs` row that projects this run's progress. */
    job_id: string;
    installation_id: number;
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

/**
 * Sends jobs as Inngest events. The event id is derived from the job id, so a re-sent event for
 * the same job is deduplicated by Inngest instead of starting a second run.
 */
export function createInngestJobQueue(sender: EventSender): JobQueue {
  return {
    async enqueue(name, payload) {
      const { ids } = await sender.send({ id: `${name}:${payload.job_id}`, name, data: { ...payload } });
      return { eventId: ids[0] ?? null };
    },
  };
}
