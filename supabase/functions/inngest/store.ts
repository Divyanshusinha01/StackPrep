import type { AnalysisErrorCode, AnalysisStage, DeepAnalysisErrorCode } from "@stackprep/shared";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { MemoryRow } from "../_shared/analysis/context.ts";

export interface AnalysisTarget {
  job_id: string;
  job_status: "queued" | "running" | "succeeded" | "failed";
  job_commit_sha: string | null;
  workspace_id: string;
  repository_id: string;
  target_commit_sha: string | null;
  owner: string;
  name: string;
  /** Null when the repository's GitHub connection was removed. */
  installation_id: number | null;
  suspended: boolean;
}

/** Service-role persistence for the analysis run. Every call is keyed by job and workspace id. */
export interface AnalysisStore {
  /** Job, workspace, repository, and connection, resolved together; null if they do not belong together. */
  loadTarget(jobId: string, workspaceId: string): Promise<AnalysisTarget | null>;
  /** Number of summary memory kinds already stored for the commit. */
  countMemory(workspaceId: string, commitSha: string): Promise<number>;
  markStage(jobId: string, stage: AnalysisStage, progress: number, runId: string): Promise<void>;
  complete(workspaceId: string, jobId: string, commitSha: string, memory: MemoryRow[]): Promise<boolean>;
  fail(workspaceId: string, jobId: string, code: AnalysisErrorCode, message: string): Promise<void>;
  /** Queues a deep_analysis job for the commit; null when already analyzed, active, or without memory. */
  requestDeepAnalysis(workspaceId: string, commitSha: string): Promise<string | null>;
  failDeepAnalysis(workspaceId: string, jobId: string, code: DeepAnalysisErrorCode, message: string): Promise<void>;
}

const TARGET_COLUMNS = "id, status, repository_commit_sha, workspace_id, " +
  "workspace:workspaces!jobs_workspace_id_user_id_fkey(id, repository_id, target_commit_sha, " +
  "repository:repositories!workspaces_repository_id_user_id_fkey(id, owner, name, " +
  "connection:github_connections!repositories_github_connection_id_user_id_fkey(installation_id, suspended_at)))";

interface TargetRow {
  id: string;
  status: AnalysisTarget["job_status"];
  repository_commit_sha: string | null;
  workspace_id: string;
  workspace: {
    id: string;
    repository_id: string;
    target_commit_sha: string | null;
    repository: {
      id: string;
      owner: string;
      name: string;
      connection: { installation_id: number; suspended_at: string | null } | null;
    } | null;
  } | null;
}

export function createAnalysisStore(serviceClient: SupabaseClient): AnalysisStore {
  return {
    async loadTarget(jobId, workspaceId) {
      const { data, error } = await serviceClient
        .from("jobs")
        .select(TARGET_COLUMNS)
        .eq("id", jobId)
        .eq("workspace_id", workspaceId)
        .eq("type", "repository_indexing")
        .maybeSingle();
      if (error) {
        throw new Error(`Failed to load analysis target: ${error.message}`);
      }
      const row = data as TargetRow | null;
      const repository = row?.workspace?.repository;
      if (!row || !row.workspace || !repository) {
        return null;
      }
      return {
        job_id: row.id,
        job_status: row.status,
        job_commit_sha: row.repository_commit_sha,
        workspace_id: row.workspace.id,
        repository_id: repository.id,
        target_commit_sha: row.workspace.target_commit_sha,
        owner: repository.owner,
        name: repository.name,
        installation_id: repository.connection?.installation_id ?? null,
        suspended: repository.connection?.suspended_at != null,
      };
    },
    async countMemory(workspaceId, commitSha) {
      const { count, error } = await serviceClient
        .from("repository_memory")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", workspaceId)
        .eq("repository_commit_sha", commitSha)
        .neq("kind", "file_summary");
      if (error) {
        throw new Error(`Failed to count repository memory: ${error.message}`);
      }
      return count ?? 0;
    },
    async markStage(jobId, stage, progress, runId) {
      const patch: Record<string, unknown> = { status: "running", stage, progress, inngest_run_id: runId };
      if (stage === "scanning") {
        patch.started_at = new Date().toISOString();
      }
      const { error } = await serviceClient
        .from("jobs")
        .update(patch)
        .eq("id", jobId)
        .in("status", ["queued", "running"]);
      if (error) {
        throw new Error(`Failed to record analysis stage: ${error.message}`);
      }
    },
    async complete(workspaceId, jobId, commitSha, memory) {
      const { data, error } = await serviceClient.rpc("complete_repository_analysis", {
        p_workspace_id: workspaceId,
        p_job_id: jobId,
        p_commit_sha: commitSha,
        p_memory: memory,
      });
      if (error) {
        throw new Error(`Failed to complete repository analysis: ${error.message}`);
      }
      return data === true;
    },
    async fail(workspaceId, jobId, code, message) {
      const { error } = await serviceClient.rpc("fail_repository_analysis", {
        p_workspace_id: workspaceId,
        p_job_id: jobId,
        p_error_code: code,
        p_error_message: message,
      });
      if (error) {
        throw new Error(`Failed to record repository analysis failure: ${error.message}`);
      }
    },
    async requestDeepAnalysis(workspaceId, commitSha) {
      const { data, error } = await serviceClient.rpc("request_deep_analysis", {
        p_workspace_id: workspaceId,
        p_commit_sha: commitSha,
      });
      if (error) {
        throw new Error(`Failed to request deep analysis: ${error.message}`);
      }
      return typeof data === "string" ? data : null;
    },
    async failDeepAnalysis(workspaceId, jobId, code, message) {
      const { error } = await serviceClient.rpc("fail_deep_analysis", {
        p_workspace_id: workspaceId,
        p_job_id: jobId,
        p_error_code: code,
        p_error_message: message,
      });
      if (error) {
        throw new Error(`Failed to record deep analysis failure: ${error.message}`);
      }
    },
  };
}
