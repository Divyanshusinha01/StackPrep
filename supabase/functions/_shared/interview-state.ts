export const STALE_INTERVIEW_STATE_SQLSTATE = "P0409";

export interface InterviewStatePayload {
  coverageMap: Record<string, unknown>;
  plan: Record<string, unknown>;
  strategy: Record<string, unknown>;
}

interface RpcError {
  code?: string;
  message: string;
  details?: string | null;
}

/** Structural subset of a service-role supabase-js client. */
export interface InterviewStateRpcClient {
  rpc(
    fn: "update_interview_state",
    args: {
      p_interview_id: string;
      p_expected_version: number;
      p_coverage_map: Record<string, unknown>;
      p_plan: Record<string, unknown>;
      p_strategy: Record<string, unknown>;
    },
  ): PromiseLike<{ data: unknown; error: RpcError | null }>;
}

/**
 * The expected version no longer matches (another writer won) or the interview has no state.
 * Callers must reload interview_state and recompute; never retry with the old payload.
 */
export class StaleInterviewStateError extends Error {
  override readonly name = "StaleInterviewStateError";

  constructor(
    readonly interviewId: string,
    readonly expectedVersion: number,
  ) {
    super(`Interview state for ${interviewId} is not at version ${expectedVersion}`);
  }
}

export class InterviewStateUpdateError extends Error {
  override readonly name = "InterviewStateUpdateError";

  constructor(
    message: string,
    readonly code: string | undefined,
  ) {
    super(message);
  }
}

/** Writes new interview state if `expectedVersion` is current and returns the new version. */
export async function updateInterviewState(
  client: InterviewStateRpcClient,
  interviewId: string,
  expectedVersion: number,
  state: InterviewStatePayload,
): Promise<number> {
  const { data, error } = await client.rpc("update_interview_state", {
    p_interview_id: interviewId,
    p_expected_version: expectedVersion,
    p_coverage_map: state.coverageMap,
    p_plan: state.plan,
    p_strategy: state.strategy,
  });

  if (error) {
    if (error.code === STALE_INTERVIEW_STATE_SQLSTATE) {
      throw new StaleInterviewStateError(interviewId, expectedVersion);
    }
    throw new InterviewStateUpdateError(error.message, error.code);
  }

  const newVersion = Number(data);
  if (!Number.isSafeInteger(newVersion) || newVersion !== expectedVersion + 1) {
    throw new InterviewStateUpdateError(`Unexpected version returned: ${String(data)}`, undefined);
  }
  return newVersion;
}
