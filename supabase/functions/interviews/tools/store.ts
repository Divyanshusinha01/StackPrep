import type { SupabaseClient } from "@supabase/supabase-js";
import { createAiUsageRecorder } from "../../_shared/ai-usage.ts";
import { type InterviewStateRpcClient, updateInterviewState } from "../../_shared/interview-state.ts";
import type { MemoryEntry, ToolCallRecordResult, ToolStore, TranscriptMessage } from "./types.ts";

const MAX_MEMORY_ROWS = 200;
const MAX_EVIDENCE_PATHS = 50;

function check(action: string, error: { message: string } | null): void {
  if (error) {
    throw new Error(`Failed to ${action}: ${error.message}`);
  }
}

interface AccessRow {
  repository: {
    owner: string;
    name: string;
    connection: { installation_id: number; suspended_at: string | null } | null;
  } | null;
}

export function createToolStore(serviceClient: SupabaseClient): ToolStore {
  const toolCalls = (interviewId: string) =>
    serviceClient.from("interview_events").select("payload").eq("interview_id", interviewId).eq("event_type", "tool_call");

  return {
    ...createAiUsageRecorder(serviceClient),
    async findToolCall(interviewId, callId) {
      const { data, error } = await toolCalls(interviewId).eq("payload->>call_id", callId).maybeSingle();
      check("load tool call", error);
      const payload = data?.payload as { tool?: string; args?: Record<string, unknown>; result?: unknown } | undefined;
      return payload ? { tool: payload.tool ?? "", args: payload.args ?? {}, result: payload.result ?? null } : null;
    },
    async recordToolCall(record) {
      const { data, error } = await serviceClient.rpc("record_tool_call", {
        p_interview_id: record.interviewId,
        p_user_id: record.userId,
        p_call_id: record.callId,
        p_tool: record.tool,
        p_args: record.args,
        p_result_summary: record.resultSummary,
        p_result: record.result ?? null,
        p_evidence: record.evidence,
        p_evaluation: record.evaluation,
      }).single();
      check("record tool call", error);
      const row = data as ToolCallRecordResult;
      return { status: row.status, sequence: row.sequence, result: row.result ?? null };
    },
    async countToolCallsSince(interviewId, tools, since) {
      const { count, error } = await serviceClient
        .from("interview_events")
        .select("id", { count: "exact", head: true })
        .eq("interview_id", interviewId)
        .eq("event_type", "tool_call")
        .in("payload->>tool", tools)
        .gte("occurred_at", since.toISOString());
      check("count tool calls", error);
      return count ?? 0;
    },
    async listRepositoryMemory(workspaceId, commitSha) {
      const { data, error } = await serviceClient
        .from("repository_memory")
        .select("kind, content, structured")
        .eq("workspace_id", workspaceId)
        .eq("repository_commit_sha", commitSha)
        .order("kind")
        .order("id")
        .limit(MAX_MEMORY_ROWS);
      check("load repository memory", error);
      return (data ?? []) as MemoryEntry[];
    },
    async getRepositoryAccess(workspaceId) {
      const { data, error } = await serviceClient
        .from("workspaces")
        .select(
          "repository:repositories!workspaces_repository_id_user_id_fkey(owner, name, " +
            "connection:github_connections!repositories_github_connection_id_user_id_fkey(installation_id, suspended_at))",
        )
        .eq("id", workspaceId)
        .maybeSingle();
      check("load repository access", error);
      const repository = (data as AccessRow | null)?.repository;
      const connection = repository?.connection;
      if (!repository || !connection || connection.suspended_at !== null) {
        return null;
      }
      return { installationId: connection.installation_id, owner: repository.owner, name: repository.name };
    },
    async getInterviewState(interviewId) {
      const { data, error } = await serviceClient
        .from("interview_state")
        .select("coverage_map, plan, strategy, version")
        .eq("interview_id", interviewId)
        .maybeSingle();
      check("load interview state", error);
      return data
        ? { coverageMap: data.coverage_map, plan: data.plan, strategy: data.strategy, version: Number(data.version) }
        : null;
    },
    updateInterviewState(interviewId, expectedVersion, state) {
      return updateInterviewState(serviceClient as unknown as InterviewStateRpcClient, interviewId, expectedVersion, state);
    },
    async listRecentMessages(interviewId, limit) {
      const { data, error } = await serviceClient
        .from("interview_messages")
        .select("id, sequence, role, content")
        .eq("interview_id", interviewId)
        .order("sequence", { ascending: false })
        .limit(limit);
      check("load transcript", error);
      return ((data ?? []) as TranscriptMessage[]).reverse();
    },
    async listEvidencePaths(interviewId) {
      const { data, error } = await serviceClient
        .from("interview_events")
        .select("payload")
        .eq("interview_id", interviewId)
        .eq("event_type", "evidence_examined")
        .order("sequence")
        .limit(MAX_EVIDENCE_PATHS);
      check("load evidence", error);
      return (data ?? [])
        .map((row) => (row.payload as { path?: unknown }).path)
        .filter((path): path is string => typeof path === "string");
    },
    async listEvaluationCategories(interviewId) {
      const { data, error } = await serviceClient.from("evaluations").select("category").eq("interview_id", interviewId);
      check("load evaluations", error);
      return (data ?? []).map((row) => row.category as string);
    },
    async lastAdvancedArea(interviewId) {
      const { data, error } = await toolCalls(interviewId)
        .eq("payload->>tool", "advance_interview")
        .order("sequence", { ascending: false })
        .limit(1)
        .maybeSingle();
      check("load last advance", error);
      const areaId = (data?.payload as { result_summary?: { area_id?: unknown } } | undefined)?.result_summary?.area_id;
      return typeof areaId === "string" ? areaId : null;
    },
    async completeInterview(interviewId, userId, reason) {
      const { data, error } = await serviceClient.rpc("complete_interview", {
        p_interview_id: interviewId,
        p_user_id: userId,
        p_reason: reason,
      });
      check("complete interview", error);
      return data === true;
    },
  };
}
