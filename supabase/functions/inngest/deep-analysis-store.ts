import type { DeepAnalysisErrorCode, DeepAnalysisResult } from "@stackprep/shared";
import type { SupabaseClient } from "@supabase/supabase-js";

const MAX_FILE_SUMMARIES = 30;

export type DeepAnalysisJobStatus = "queued" | "running" | "succeeded" | "failed";

export interface DeepAnalysisTarget {
  job_id: string;
  job_status: DeepAnalysisJobStatus;
  workspace_id: string;
  /** The analyzed commit the job is pinned to. */
  commit_sha: string | null;
  /** The commit's architecture_summary row already carries the `metadata.deep_analysis` marker. */
  already_analyzed: boolean;
}

export interface DeepAnalysisMemoryRow {
  kind: string;
  content: string;
}

/** Baseline memory for exactly one commit. */
export interface DeepAnalysisMemory {
  rows: DeepAnalysisMemoryRow[];
  /** `key_files.structured.files[].path`: the only paths the analysis may cite as evidence. */
  evidence_paths: string[];
}

/** What `save_deep_analysis` writes: `structured.ai` per row plus the commit's concepts row. */
export interface DeepAnalysisPayload {
  model: string;
  analyzer_version: string;
  architecture_summary: Pick<DeepAnalysisResult, "architecture_summary" | "technical_decisions" | "security_sensitive_areas">;
  modules: Pick<DeepAnalysisResult, "important_modules">;
  concepts: { content: string; ai: Pick<DeepAnalysisResult, "concepts"> };
}

/** Service-role persistence for the deep analysis run. Every call is keyed by job and workspace id. */
export interface DeepAnalysisStore {
  loadTarget(jobId: string, workspaceId: string): Promise<DeepAnalysisTarget | null>;
  loadMemory(workspaceId: string, commitSha: string): Promise<DeepAnalysisMemory>;
  markStage(jobId: string, progress: number, runId: string): Promise<void>;
  markSucceeded(jobId: string): Promise<void>;
  /** Writes the analysis and marks the job succeeded in one transaction (`save_deep_analysis`). */
  complete(workspaceId: string, jobId: string, commitSha: string, payload: DeepAnalysisPayload): Promise<void>;
  fail(workspaceId: string, jobId: string, code: DeepAnalysisErrorCode, message: string): Promise<void>;
}

function check(action: string, error: { message: string } | null): void {
  if (error) {
    throw new Error(`Failed to ${action}: ${error.message}`);
  }
}

function evidencePaths(structured: unknown): string[] {
  const files = (structured as { files?: unknown } | null)?.files;
  if (!Array.isArray(files)) {
    return [];
  }
  return files.flatMap((f) => typeof f?.path === "string" ? [f.path as string] : []);
}

export function createDeepAnalysisStore(serviceClient: SupabaseClient): DeepAnalysisStore {
  return {
    async loadTarget(jobId, workspaceId) {
      const { data: job, error } = await serviceClient
        .from("jobs")
        .select("id, status, workspace_id, repository_commit_sha")
        .eq("id", jobId)
        .eq("workspace_id", workspaceId)
        .eq("type", "deep_analysis")
        .maybeSingle();
      check("load deep analysis job", error);
      if (!job) {
        return null;
      }
      let alreadyAnalyzed = false;
      if (job.repository_commit_sha) {
        const { data: summary, error: summaryError } = await serviceClient
          .from("repository_memory")
          .select("metadata")
          .eq("workspace_id", workspaceId)
          .eq("repository_commit_sha", job.repository_commit_sha)
          .eq("kind", "architecture_summary")
          .maybeSingle();
        check("load architecture summary", summaryError);
        const metadata = summary?.metadata as Record<string, unknown> | null | undefined;
        alreadyAnalyzed = metadata != null && "deep_analysis" in metadata;
      }
      return {
        job_id: job.id,
        job_status: job.status,
        workspace_id: job.workspace_id,
        commit_sha: job.repository_commit_sha,
        already_analyzed: alreadyAnalyzed,
      };
    },

    async loadMemory(workspaceId, commitSha) {
      const [summaries, files] = await Promise.all([
        serviceClient.from("repository_memory").select("kind, content, structured")
          .eq("workspace_id", workspaceId).eq("repository_commit_sha", commitSha)
          .not("kind", "in", "(file_summary,concepts)").order("kind"),
        serviceClient.from("repository_memory").select("kind, content")
          .eq("workspace_id", workspaceId).eq("repository_commit_sha", commitSha)
          .eq("kind", "file_summary").order("created_at").limit(MAX_FILE_SUMMARIES),
      ]);
      check("load repository memory", summaries.error);
      check("load file summaries", files.error);
      const rows = summaries.data ?? [];
      if (!rows.some((r) => r.kind === "architecture_summary")) {
        return { rows: [], evidence_paths: [] };
      }
      return {
        rows: [...rows, ...(files.data ?? [])].map(({ kind, content }) => ({ kind, content })),
        evidence_paths: evidencePaths(rows.find((r) => r.kind === "key_files")?.structured),
      };
    },

    async markStage(jobId, progress, runId) {
      const { error } = await serviceClient
        .from("jobs")
        .update({
          status: "running",
          stage: "deep_analysis",
          progress,
          inngest_run_id: runId,
          started_at: new Date().toISOString(),
        })
        .eq("id", jobId)
        .eq("type", "deep_analysis")
        .in("status", ["queued", "running"]);
      check("record deep analysis stage", error);
    },

    async markSucceeded(jobId) {
      const { error } = await serviceClient
        .from("jobs")
        .update({
          status: "succeeded",
          progress: 100,
          stage: null,
          error_code: null,
          error_message: null,
          finished_at: new Date().toISOString(),
        })
        .eq("id", jobId)
        .eq("type", "deep_analysis");
      check("complete deep analysis job", error);
    },

    async complete(workspaceId, jobId, commitSha, payload) {
      const { error } = await serviceClient.rpc("save_deep_analysis", {
        p_workspace_id: workspaceId,
        p_job_id: jobId,
        p_commit_sha: commitSha,
        p_payload: payload,
      });
      check("save deep analysis", error);
    },

    async fail(workspaceId, jobId, code, message) {
      const { error } = await serviceClient.rpc("fail_deep_analysis", {
        p_workspace_id: workspaceId,
        p_job_id: jobId,
        p_error_code: code,
        p_error_message: message,
      });
      check("record deep analysis failure", error);
    },
  };
}
