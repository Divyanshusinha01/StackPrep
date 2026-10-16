import type { AnalysisErrorCode, WorkspaceStatus } from "@stackprep/shared";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface PushSyncWorkspace {
  workspace_id: string;
  repository_id: string;
  status: WorkspaceStatus;
  owner: string;
  name: string;
  /** Null when the repository's GitHub connection was removed. */
  installation_id: number | null;
  suspended: boolean;
  /** Whether the owner has a stored OpenAI key whose status is `valid`. */
  openai_key_valid: boolean;
}

export interface PushGenerations {
  push_generation: number;
  synced_generation: number;
}

export type FollowOutcome = "not_ready" | "analysis_active" | "up_to_date" | "queued";

export interface FollowResult {
  job_id: string | null;
  outcome: FollowOutcome;
}

export interface PendingPushWorkspace {
  workspace_id: string;
  installation_id: number;
  push_generation: number;
}

/** Service-role persistence for push sync and its reconciler. */
export interface PushSyncStore {
  loadWorkspace(workspaceId: string): Promise<PushSyncWorkspace | null>;
  /** Null when the workspace no longer exists. */
  readGenerations(workspaceId: string): Promise<PushGenerations | null>;
  /** `follow_repository_head`: moves the target and queues a baseline when the head is new. */
  followHead(workspaceId: string, commitSha: string, observedGeneration: number): Promise<FollowResult>;
  /** `reopen_push_sync`: makes the push pending again after its analysis could not be enqueued. */
  reopen(workspaceId: string, observedGeneration: number): Promise<boolean>;
  failAnalysis(workspaceId: string, jobId: string, code: AnalysisErrorCode, message: string): Promise<void>;
  listPending(limit: number): Promise<PendingPushWorkspace[]>;
}

const WORKSPACE_COLUMNS = "id, user_id, status, repository_id, " +
  "repository:repositories!workspaces_repository_id_user_id_fkey(owner, name, " +
  "connection:github_connections!repositories_github_connection_id_user_id_fkey(installation_id, suspended_at))";

interface WorkspaceRow {
  id: string;
  user_id: string;
  status: WorkspaceStatus;
  repository_id: string;
  repository: {
    owner: string;
    name: string;
    connection: { installation_id: number; suspended_at: string | null } | null;
  } | null;
}

const FOLLOW_OUTCOMES: ReadonlySet<string> = new Set(["not_ready", "analysis_active", "up_to_date", "queued"]);

function check(action: string, error: { message: string } | null): void {
  if (error) {
    throw new Error(`Failed to ${action}: ${error.message}`);
  }
}

export function createPushSyncStore(serviceClient: SupabaseClient): PushSyncStore {
  return {
    async loadWorkspace(workspaceId) {
      const { data, error } = await serviceClient
        .from("workspaces")
        .select(WORKSPACE_COLUMNS)
        .eq("id", workspaceId)
        .maybeSingle();
      check("load push sync workspace", error);
      const row = data as WorkspaceRow | null;
      if (!row || !row.repository) {
        return null;
      }
      const { data: key, error: keyError } = await serviceClient
        .from("openai_credentials")
        .select("status")
        .eq("user_id", row.user_id)
        .maybeSingle();
      check("load push sync key status", keyError);
      return {
        workspace_id: row.id,
        repository_id: row.repository_id,
        status: row.status,
        owner: row.repository.owner,
        name: row.repository.name,
        installation_id: row.repository.connection?.installation_id ?? null,
        suspended: row.repository.connection?.suspended_at != null,
        openai_key_valid: key?.status === "valid",
      };
    },

    async readGenerations(workspaceId) {
      const { data, error } = await serviceClient
        .from("workspaces")
        .select("push_generation, synced_generation")
        .eq("id", workspaceId)
        .maybeSingle();
      check("read push generations", error);
      return data ? { push_generation: Number(data.push_generation), synced_generation: Number(data.synced_generation) } : null;
    },

    async followHead(workspaceId, commitSha, observedGeneration) {
      const { data, error } = await serviceClient.rpc("follow_repository_head", {
        p_workspace_id: workspaceId,
        p_commit_sha: commitSha,
        p_observed_generation: observedGeneration,
      });
      check("follow repository head", error);
      const row = (Array.isArray(data) ? data[0] : data) as { job_id: string | null; outcome: string } | undefined;
      if (!row || !FOLLOW_OUTCOMES.has(row.outcome)) {
        throw new Error("Failed to follow repository head: unexpected result");
      }
      return { job_id: row.job_id ?? null, outcome: row.outcome as FollowOutcome };
    },

    async reopen(workspaceId, observedGeneration) {
      const { data, error } = await serviceClient.rpc("reopen_push_sync", {
        p_workspace_id: workspaceId,
        p_observed_generation: observedGeneration,
      });
      check("reopen push sync", error);
      return data === true;
    },

    async failAnalysis(workspaceId, jobId, code, message) {
      const { error } = await serviceClient.rpc("fail_repository_analysis", {
        p_workspace_id: workspaceId,
        p_job_id: jobId,
        p_error_code: code,
        p_error_message: message,
      });
      check("record repository analysis failure", error);
    },

    async listPending(limit) {
      const { data, error } = await serviceClient.rpc("list_pending_push_workspaces", { p_limit: limit });
      check("list pending push workspaces", error);
      return ((data ?? []) as PendingPushWorkspace[]).map((row) => ({
        workspace_id: row.workspace_id,
        installation_id: Number(row.installation_id),
        push_generation: Number(row.push_generation),
      }));
    },
  };
}
