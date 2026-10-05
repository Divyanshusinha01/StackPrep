import type { EvidenceExaminedPayload } from "@stackprep/shared";
import { GithubUnexpectedResponseError, type GithubApp, type RepositoryTreeEntry } from "../_shared/github-app.ts";
import { StaleInterviewStateError } from "../_shared/interview-state.ts";
import type {
  EvaluationRecord,
  InterviewStateSnapshot,
  MemoryEntry,
  RepositoryAccess,
  ToolCallRecord,
  ToolStore,
  TranscriptMessage,
} from "./tools/types.ts";

function stable(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stable).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${k}:${stable((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export interface FakeToolStore extends ToolStore {
  records: ToolCallRecord[];
  evidence: EvidenceExaminedPayload[];
  evaluations: EvaluationRecord[];
  completions: ("time_limit" | null)[];
  stateUpdates: InterviewStateSnapshot[];
  memory: MemoryEntry[];
  messages: TranscriptMessage[];
  state: InterviewStateSnapshot | null;
  access: RepositoryAccess | null;
  /** Number of upcoming state updates that fail as stale (after another writer bumps the version). */
  staleUpdates: number;
  /** Extra read-tool calls counted by the rate limiter. */
  recentReads: number;
  status: "in_progress" | "completed";
}

/** In-memory ToolStore with the same dedupe semantics as record_tool_call and complete_interview. */
export function createFakeToolStore(init: Partial<Pick<FakeToolStore, "memory" | "messages" | "state" | "access">> = {}): FakeToolStore {
  const store: FakeToolStore = {
    records: [],
    evidence: [],
    evaluations: [],
    completions: [],
    stateUpdates: [],
    memory: init.memory ?? [],
    messages: init.messages ?? [],
    state: init.state ?? null,
    access: init.access === undefined ? { installationId: 42, owner: "alice", name: "demo" } : init.access,
    staleUpdates: 0,
    recentReads: 0,
    status: "in_progress",

    findToolCall(_interviewId, callId) {
      const record = store.records.find((r) => r.callId === callId);
      return Promise.resolve(record ? { tool: record.tool, args: record.args, result: record.result ?? null } : null);
    },
    recordToolCall(record) {
      const index = store.records.findIndex((r) => r.callId === record.callId);
      if (index !== -1) {
        const existing = store.records[index];
        const same = existing.tool === record.tool && stable(existing.args) === stable(record.args);
        return Promise.resolve({
          status: same ? "duplicate" : "event_conflict",
          sequence: index + 1,
          result: same ? existing.result ?? null : null,
        });
      }
      store.records.push(record);
      for (const item of record.evidence) {
        if (!store.evidence.some((e) => e.path === item.path)) {
          store.evidence.push(item);
        }
      }
      if (record.evaluation) {
        store.evaluations.push(record.evaluation);
      }
      return Promise.resolve({ status: "created", sequence: store.records.length, result: record.result ?? null });
    },
    countToolCallsSince(_interviewId, tools) {
      return Promise.resolve(store.recentReads + store.records.filter((r) => tools.includes(r.tool)).length);
    },
    listRepositoryMemory: () => Promise.resolve(store.memory),
    getRepositoryAccess: () => Promise.resolve(store.access),
    getInterviewState: () => Promise.resolve(store.state ? structuredClone(store.state) : null),
    updateInterviewState(interviewId, expectedVersion, next) {
      if (!store.state) {
        return Promise.reject(new StaleInterviewStateError(interviewId, expectedVersion));
      }
      if (store.staleUpdates > 0) {
        store.staleUpdates--;
        store.state = { ...store.state, version: store.state.version + 1 };
      }
      if (store.state.version !== expectedVersion) {
        return Promise.reject(new StaleInterviewStateError(interviewId, expectedVersion));
      }
      store.state = { coverageMap: next.coverageMap, plan: next.plan, strategy: next.strategy, version: expectedVersion + 1 };
      store.stateUpdates.push(structuredClone(store.state));
      return Promise.resolve(store.state.version);
    },
    listRecentMessages: (_id, limit) => Promise.resolve(store.messages.slice(-limit)),
    listEvidencePaths: () => Promise.resolve(store.evidence.map((e) => e.path)),
    listEvaluationCategories: () => Promise.resolve(store.evaluations.map((e) => e.category)),
    lastAdvancedArea() {
      const last = store.records.filter((r) => r.tool === "advance_interview").at(-1);
      const areaId = last?.resultSummary.area_id;
      return Promise.resolve(typeof areaId === "string" ? areaId : null);
    },
    completeInterview(_interviewId, _userId, reason) {
      store.completions.push(reason);
      if (store.status !== "in_progress") {
        return Promise.resolve(false);
      }
      store.status = "completed";
      return Promise.resolve(true);
    },
  };
  return store;
}

export interface FakeGithub extends GithubApp {
  treeCalls: number;
  blobCalls: number;
}

/** Serves a fixed tree; file contents are keyed by path, and blob shas are derived from the path. */
export function createFakeGithub(
  files: Record<string, string | Uint8Array>,
  { fail, extraEntries = [] }: { fail?: () => Error; extraEntries?: RepositoryTreeEntry[] } = {},
): FakeGithub {
  const sha = (path: string) => Array.from(new TextEncoder().encode(path.padEnd(20, "_").slice(0, 20)), (b) => b.toString(16).padStart(2, "0")).join("");
  const bytes = (content: string | Uint8Array) => (typeof content === "string" ? new TextEncoder().encode(content) : content);
  const bySha = new Map(Object.entries(files).map(([path, content]) => [sha(path), bytes(content)]));
  const unsupported = () => Promise.reject(new GithubUnexpectedResponseError());
  const github: FakeGithub = {
    treeCalls: 0,
    blobCalls: 0,
    verifyUserInstallation: unsupported,
    getInstallation: unsupported,
    listAllInstallationRepositories: unsupported,
    getRepositoryHead: unsupported,
    getRepositoryTree() {
      github.treeCalls++;
      if (fail) {
        return Promise.reject(fail());
      }
      const entries: RepositoryTreeEntry[] = Object.entries(files).map(([path, content]) => ({
        path,
        type: "blob",
        sha: sha(path),
        size: bytes(content).length,
      }));
      return Promise.resolve({ entries: [...entries, ...extraEntries], truncated: false });
    },
    getBlob(_installationId, _owner, _name, blobSha, maxBytes) {
      github.blobCalls++;
      const content = bySha.get(blobSha);
      return Promise.resolve(content && content.length <= maxBytes ? content : null);
    },
    _internal: { getInstallationToken: unsupported, createAppJwt: unsupported },
  };
  return github;
}
