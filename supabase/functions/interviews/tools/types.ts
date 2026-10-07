import type {
  EvidenceExaminedPayload,
  RealtimeToolName,
  ToolCallResponse,
  ToolError,
  ToolErrorCode,
} from "@stackprep/shared";
import type { AIProvider, EmbeddingProvider } from "../../_shared/ai/provider.ts";
import type { AiUsageRecorder } from "../../_shared/ai-usage.ts";
import type { GithubApp } from "../../_shared/github-app.ts";
import type { InterviewStatePayload } from "../../_shared/interview-state.ts";
import type { TreeCache } from "./get-file.ts";

export interface ToolInterview {
  id: string;
  workspace_id: string;
  repository_commit_sha: string;
}

export interface StoredToolCall {
  tool: string;
  args: Record<string, unknown>;
  /** Stored for state-changing tools only; read-only tools are re-executed on replay. */
  result: unknown;
}

/** One hidden `evaluations` row; `message_id` is the question being answered. */
export interface EvaluationRecord {
  message_id: string;
  category: string;
  score: number;
  rating: "strong" | "proficient" | "developing" | "weak" | "insufficient_evidence";
  strengths: string[];
  gaps: string[];
  repo_evidence: string[];
  discrepancy: boolean;
  discrepancy_detail: string;
}

export interface ToolCallRecord {
  interviewId: string;
  userId: string;
  callId: string;
  tool: RealtimeToolName;
  args: Record<string, unknown>;
  resultSummary: Record<string, unknown>;
  result: unknown;
  evidence: EvidenceExaminedPayload[];
  evaluation: EvaluationRecord | null;
}

export interface ToolCallRecordResult {
  status: "created" | "duplicate" | "event_conflict";
  sequence: number;
  result: unknown;
}

export interface MemoryEntry {
  kind: string;
  content: string;
  structured: Record<string, unknown>;
}

/** A `match_repository_memory` row; the vector itself is never returned. */
export interface MemoryMatch {
  kind: string;
  content: string;
  /** 1 - cosine distance. */
  similarity: number;
}

export interface RepositoryAccess {
  installationId: number;
  owner: string;
  name: string;
}

export interface InterviewStateSnapshot {
  coverageMap: unknown;
  plan: unknown;
  strategy: unknown;
  version: number;
}

export interface TranscriptMessage {
  id: string;
  sequence: number;
  role: "ai" | "user" | "system";
  content: string;
}

/**
 * Service-role persistence for tool calls. Every call is keyed by an interview (or its workspace)
 * the caller has already been shown to own through the RLS reader.
 */
export interface ToolStore extends AiUsageRecorder {
  findToolCall(interviewId: string, callId: string): Promise<StoredToolCall | null>;
  recordToolCall(record: ToolCallRecord): Promise<ToolCallRecordResult>;
  countToolCallsSince(interviewId: string, tools: RealtimeToolName[], since: Date): Promise<number>;
  listRepositoryMemory(workspaceId: string, commitSha: string): Promise<MemoryEntry[]>;
  /** Embedded memory rows of the commit, nearest first. Rows without an embedding are skipped. */
  matchRepositoryMemory(
    workspaceId: string,
    commitSha: string,
    embedding: number[],
    limit: number,
    signal?: AbortSignal,
  ): Promise<MemoryMatch[]>;
  /** Null when the repository's GitHub connection is missing or suspended. */
  getRepositoryAccess(workspaceId: string): Promise<RepositoryAccess | null>;
  getInterviewState(interviewId: string): Promise<InterviewStateSnapshot | null>;
  /** Throws StaleInterviewStateError when `expectedVersion` is no longer current. */
  updateInterviewState(interviewId: string, expectedVersion: number, state: InterviewStatePayload): Promise<number>;
  /** The newest `limit` messages, in sequence order. */
  listRecentMessages(interviewId: string, limit: number): Promise<TranscriptMessage[]>;
  listEvidencePaths(interviewId: string): Promise<string[]>;
  /** `evaluations.category` of every evaluation so far. */
  listEvaluationCategories(interviewId: string): Promise<string[]>;
  /** Coverage area id chosen by the latest advance_interview call, if any. */
  lastAdvancedArea(interviewId: string): Promise<string | null>;
  /** in_progress -> completed with a `completion` event; false if it was not in progress. */
  completeInterview(interviewId: string, userId: string, reason: "time_limit" | null): Promise<boolean>;
}

export interface SearchEmbeddings {
  provider: EmbeddingProvider;
  model: string;
  /** Total budget for the vector fill (query embedding plus match); defaults to VECTOR_SEARCH_BUDGET_MS. */
  budgetMs?: number;
}

export interface ToolContext {
  interview: ToolInterview;
  userId: string;
  store: ToolStore;
  github: GithubApp;
  trees: TreeCache;
  ai: AIProvider;
  evaluationModel: string;
  /** Enables the vector fill in search_repository; keyword search alone without it. */
  embeddings?: SearchEmbeddings;
  elapsedSeconds: number;
  /** Queues report generation after this call completed the interview. Never throws. */
  requestReport: () => Promise<void>;
  log: (entry: Record<string, string | number | boolean>) => void;
}

export interface ToolOutcome {
  output: ToolCallResponse;
  summary: Record<string, unknown>;
  evidence?: EvidenceExaminedPayload[];
  evaluation?: EvaluationRecord;
  /** State-changing tools store their output so a replayed call_id gets the same answer. */
  persist?: boolean;
  /** False for transient failures, so a retry of the same call_id executes again. */
  record?: boolean;
  /** Runs once, only when this call's record was newly created. */
  afterRecord?: () => Promise<void>;
}

export function toolError(code: ToolErrorCode, guidance?: string): ToolError {
  return guidance ? { ok: false, error: { code }, guidance } : { ok: false, error: { code } };
}

export function failed(code: ToolErrorCode, record = true): ToolOutcome {
  return { output: toolError(code), summary: { ok: false, code }, record };
}

/** Top-level directory of a repository path, used as its area. */
export function topLevelArea(path: string): string | undefined {
  const slash = path.indexOf("/");
  return slash > 0 ? path.slice(0, slash) : undefined;
}
