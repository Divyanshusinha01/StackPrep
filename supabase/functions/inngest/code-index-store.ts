import type { SupabaseClient } from "@supabase/supabase-js";
import type { CodeFilePayload } from "../_shared/code-index/mapper.ts";
import type { CodeMemoryRow } from "../_shared/code-index/memory.ts";
import type { CodeIndexErrorCode } from "./code-index.ts";

/** Interviews in these states may still read the code index of their pinned commit. */
const ACTIVE_INTERVIEW_STATUSES = ["created", "in_progress", "paused"];

export type CodeIndexJobStatus = "queued" | "running" | "succeeded" | "failed";

export interface CodeIndexTarget {
  job_id: string;
  job_status: CodeIndexJobStatus;
  workspace_id: string;
  /** The analyzed commit the job is pinned to. */
  commit_sha: string | null;
  owner: string;
  name: string;
  /** Null when the repository's GitHub connection was removed. */
  installation_id: number | null;
  suspended: boolean;
}

/** Service-role persistence for the code index run. Every call is keyed by job and workspace id. */
export interface CodeIndexStore {
  loadTarget(jobId: string, workspaceId: string): Promise<CodeIndexTarget | null>;
  markStage(jobId: string, progress: number, runId: string): Promise<void>;
  /** One batch through `replace_code_index`; returns the number of files written (unchanged ones are skipped). */
  replaceFiles(workspaceId: string, commitSha: string, parserVersion: string, files: CodeFilePayload[]): Promise<number>;
  /** Replaces the commit's code-index memory rows; returns the number inserted. */
  saveMemory(workspaceId: string, jobId: string, commitSha: string, rows: CodeMemoryRow[]): Promise<number>;
  /** Writes the commit's `code_index` row and marks the job succeeded. */
  complete(workspaceId: string, jobId: string, commitSha: string, parserVersion: string, summary: Record<string, unknown>): Promise<void>;
  /** Commits whose index must survive pruning: the workspace target and active interviews' commits. */
  listRetainedCommits(workspaceId: string): Promise<string[]>;
  prune(workspaceId: string, keepCommits: string[]): Promise<number>;
  fail(workspaceId: string, jobId: string, code: CodeIndexErrorCode, message: string): Promise<void>;
}

const TARGET_COLUMNS = "id, status, repository_commit_sha, workspace_id, " +
  "workspace:workspaces!jobs_workspace_id_user_id_fkey(id, " +
  "repository:repositories!workspaces_repository_id_user_id_fkey(owner, name, " +
  "connection:github_connections!repositories_github_connection_id_user_id_fkey(installation_id, suspended_at)))";

interface TargetRow {
  id: string;
  status: CodeIndexJobStatus;
  repository_commit_sha: string | null;
  workspace_id: string;
  workspace: {
    id: string;
    repository: {
      owner: string;
      name: string;
      connection: { installation_id: number; suspended_at: string | null } | null;
    } | null;
  } | null;
}

function check(action: string, error: { message: string } | null): void {
  if (error) {
    throw new Error(`Failed to ${action}: ${error.message}`);
  }
}

export function createCodeIndexStore(serviceClient: SupabaseClient): CodeIndexStore {
  return {
    async loadTarget(jobId, workspaceId) {
      const { data, error } = await serviceClient
        .from("jobs")
        .select(TARGET_COLUMNS)
        .eq("id", jobId)
        .eq("workspace_id", workspaceId)
        .eq("type", "code_indexing")
        .maybeSingle();
      check("load code index target", error);
      const row = data as TargetRow | null;
      const repository = row?.workspace?.repository;
      if (!row || !row.workspace || !repository) {
        return null;
      }
      return {
        job_id: row.id,
        job_status: row.status,
        workspace_id: row.workspace.id,
        commit_sha: row.repository_commit_sha,
        owner: repository.owner,
        name: repository.name,
        installation_id: repository.connection?.installation_id ?? null,
        suspended: repository.connection?.suspended_at != null,
      };
    },

    async markStage(jobId, progress, runId) {
      const { error } = await serviceClient
        .from("jobs")
        .update({ status: "running", stage: "code_indexing", progress, inngest_run_id: runId })
        .eq("id", jobId)
        .eq("type", "code_indexing")
        .in("status", ["queued", "running"]);
      check("record code index stage", error);
      // started_at is set once, on the first stage.
      const { error: startError } = await serviceClient
        .from("jobs")
        .update({ started_at: new Date().toISOString() })
        .eq("id", jobId)
        .is("started_at", null);
      check("record code index start", startError);
    },

    async replaceFiles(workspaceId, commitSha, parserVersion, files) {
      const { data, error } = await serviceClient.rpc("replace_code_index", {
        p_workspace_id: workspaceId,
        p_commit_sha: commitSha,
        p_parser_version: parserVersion,
        p_files: files,
      });
      check("replace code index", error);
      return typeof data === "number" ? data : 0;
    },

    async saveMemory(workspaceId, jobId, commitSha, rows) {
      const { data, error } = await serviceClient.rpc("save_code_memory", {
        p_workspace_id: workspaceId,
        p_job_id: jobId,
        p_commit_sha: commitSha,
        p_rows: rows,
      });
      check("save code memory", error);
      return typeof data === "number" ? data : 0;
    },

    async complete(workspaceId, jobId, commitSha, parserVersion, summary) {
      const { error } = await serviceClient.rpc("complete_code_index", {
        p_workspace_id: workspaceId,
        p_job_id: jobId,
        p_commit_sha: commitSha,
        p_parser_version: parserVersion,
        p_summary: summary,
      });
      check("complete code index", error);
    },

    async listRetainedCommits(workspaceId) {
      const [workspace, interviews] = await Promise.all([
        serviceClient.from("workspaces").select("target_commit_sha, indexed_commit_sha").eq("id", workspaceId).maybeSingle(),
        serviceClient.from("interviews").select("repository_commit_sha")
          .eq("workspace_id", workspaceId).in("status", ACTIVE_INTERVIEW_STATUSES),
      ]);
      check("load workspace commits", workspace.error);
      check("load interview commits", interviews.error);
      const commits = [
        workspace.data?.target_commit_sha,
        workspace.data?.indexed_commit_sha,
        ...(interviews.data ?? []).map((i) => i.repository_commit_sha),
      ];
      return [...new Set(commits.filter((c): c is string => typeof c === "string"))].sort();
    },

    async prune(workspaceId, keepCommits) {
      const { data, error } = await serviceClient.rpc("prune_code_index", {
        p_workspace_id: workspaceId,
        p_keep_commits: keepCommits,
      });
      check("prune code index", error);
      return typeof data === "number" ? data : 0;
    },

    async fail(workspaceId, jobId, code, message) {
      const { error } = await serviceClient.rpc("fail_code_index", {
        p_workspace_id: workspaceId,
        p_job_id: jobId,
        p_error_code: code,
        p_error_message: message,
      });
      check("record code index failure", error);
    },
  };
}
