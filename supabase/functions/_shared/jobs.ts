export interface JobEvents {
  "repository.index": {
    workspace_id: string;
    repository_id: string;
    commit_sha: string;
    installation_id: number;
  };
}

export type JobEventName = keyof JobEvents;

export interface EnqueueResult {
  /** Id assigned by the job runner; null until a real runner (Inngest) is wired in. */
  eventId: string | null;
}

export interface JobQueue {
  enqueue<E extends JobEventName>(name: E, payload: JobEvents[E]): Promise<EnqueueResult>;
}

/** Placeholder runner: records the event and returns no id. Swapped for Inngest in `index.ts`. */
export function createLoggingJobQueue(log: (line: string) => void = console.log): JobQueue {
  return {
    enqueue(name, payload) {
      log(JSON.stringify({ event: "job_enqueued", name, workspace_id: payload.workspace_id }));
      return Promise.resolve({ eventId: null });
    },
  };
}
