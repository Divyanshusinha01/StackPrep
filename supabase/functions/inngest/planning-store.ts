import {
  coverageMapSchema,
  type InterviewPlanningOutput,
  type InterviewStatus,
  type PlanningErrorCode,
  type PlanningState,
} from "@stackprep/shared";
import type { SupabaseClient } from "@supabase/supabase-js";
import { type AiUsageRecorder, createAiUsageRecorder } from "../_shared/ai-usage.ts";
import { NON_SUMMARY_KINDS } from "../_shared/code-index/memory.ts";
import {
  type InterviewStateRpcClient,
  StaleInterviewStateError,
  updateInterviewState,
} from "../_shared/interview-state.ts";

/** Planning writes state exactly once, from the version `create_interview` starts at. */
export const INITIAL_STATE_VERSION = 1;

const MAX_PRIOR_INTERVIEWS = 5;
const MAX_FILE_SUMMARIES = 30;
const MAX_PRIOR_ITEMS = 5;
/** Evaluator-written strengths and gaps may quote an answer; only short labels are kept. */
export const MAX_PRIOR_ITEM_CHARS = 200;
/** Only finished interviews have outcomes; in-progress, paused, and failed ones are partial. */
export const PRIOR_OUTCOME_STATUSES: InterviewStatus[] = ["completed", "terminated"];

export interface PlanningTarget {
  job_id: string;
  job_status: PlanningState;
  job_commit_sha: string | null;
  user_id: string;
  interview_id: string;
  workspace_id: string;
  interview_number: number;
  interview_status: InterviewStatus;
  /** The interview's pinned commit. */
  commit_sha: string;
  state_version: number;
  repository_full_name: string;
}

export interface PlanningMemory {
  kind: string;
  content: string;
  /** `structured.ai` written by deep analysis; absent until it has run for the commit. */
  ai?: unknown;
}

export interface PriorCategoryOutcome {
  category: string;
  ratings: string[];
  strengths: string[];
  gaps: string[];
}

/** Earlier interview in the same workspace. Guidance for question selection only. */
export interface PriorOutcome {
  interview_number: number;
  status: InterviewStatus;
  coverage: { id: string; name: string; status: string }[];
  categories: PriorCategoryOutcome[];
}

/** Service-role persistence for the planning run. Every call is keyed by job or interview id. */
export interface PlanningStore extends AiUsageRecorder {
  /** Job, interview, state version, and repository, resolved together; null if any is missing. */
  loadPlanningTarget(jobId: string): Promise<PlanningTarget | null>;
  /** Memory for exactly this commit; summary kinds first, then a bounded set of file summaries. */
  loadMemory(workspaceId: string, commitSha: string): Promise<PlanningMemory[]>;
  loadPriorOutcomes(workspaceId: string, interviewId: string): Promise<PriorOutcome[]>;
  markPlanningStage(jobId: string, progress: number, runId: string): Promise<void>;
  /** Writes the plan at the initial version and marks the job succeeded; false if a plan already existed. */
  completePlanning(interviewId: string, jobId: string, output: InterviewPlanningOutput): Promise<boolean>;
  markPlanningSucceeded(jobId: string): Promise<void>;
  failPlanning(jobId: string, code: PlanningErrorCode, message: string): Promise<void>;
}

function check(action: string, error: { message: string } | null): void {
  if (error) {
    throw new Error(`Failed to ${action}: ${error.message}`);
  }
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function priorItems(items: string[]): string[] {
  return items.slice(0, MAX_PRIOR_ITEMS).map((item) => item.slice(0, MAX_PRIOR_ITEM_CHARS));
}

export function createPlanningStore(serviceClient: SupabaseClient): PlanningStore {
  async function markPlanningSucceeded(jobId: string): Promise<void> {
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
      .eq("type", "interview_planning");
    check("complete planning job", error);
  }

  return {
    ...createAiUsageRecorder(serviceClient),
    markPlanningSucceeded,

    async loadPlanningTarget(jobId) {
      const { data: job, error } = await serviceClient
        .from("jobs")
        .select("id, status, repository_commit_sha, user_id, interview_id, workspace_id")
        .eq("id", jobId)
        .eq("type", "interview_planning")
        .maybeSingle();
      check("load planning job", error);
      if (!job?.interview_id) {
        return null;
      }

      const [interview, state, workspace] = await Promise.all([
        serviceClient.from("interviews")
          .select("id, workspace_id, interview_number, status, repository_commit_sha")
          .eq("id", job.interview_id).eq("workspace_id", job.workspace_id).maybeSingle(),
        serviceClient.from("interview_state").select("version").eq("interview_id", job.interview_id).maybeSingle(),
        serviceClient.from("workspaces")
          .select("id, repository:repositories!workspaces_repository_id_user_id_fkey(full_name)")
          .eq("id", job.workspace_id).maybeSingle(),
      ]);
      check("load interview", interview.error);
      check("load interview state", state.error);
      check("load workspace", workspace.error);
      const repository = workspace.data?.repository as unknown as { full_name: string } | null | undefined;
      if (!interview.data || !state.data || !repository) {
        return null;
      }
      return {
        job_id: job.id,
        job_status: job.status,
        job_commit_sha: job.repository_commit_sha,
        user_id: job.user_id,
        interview_id: interview.data.id,
        workspace_id: interview.data.workspace_id,
        interview_number: interview.data.interview_number,
        interview_status: interview.data.status,
        commit_sha: interview.data.repository_commit_sha,
        state_version: Number(state.data.version),
        repository_full_name: repository.full_name,
      };
    },

    async loadMemory(workspaceId, commitSha) {
      const [summaries, files] = await Promise.all([
        serviceClient.from("repository_memory").select("kind, content, ai:structured->ai")
          .eq("workspace_id", workspaceId).eq("repository_commit_sha", commitSha)
          .not("kind", "in", NON_SUMMARY_KINDS).order("kind"),
        serviceClient.from("repository_memory").select("kind, content")
          .eq("workspace_id", workspaceId).eq("repository_commit_sha", commitSha)
          .eq("kind", "file_summary").order("created_at").limit(MAX_FILE_SUMMARIES),
      ]);
      check("load repository memory", summaries.error);
      check("load file summaries", files.error);
      if (!summaries.data?.length) {
        return [];
      }
      return [...summaries.data, ...(files.data ?? [])] as PlanningMemory[];
    },

    async loadPriorOutcomes(workspaceId, interviewId) {
      const { data: interviews, error } = await serviceClient
        .from("interviews")
        .select("id, interview_number, status, state:interview_state(coverage_map)")
        .eq("workspace_id", workspaceId)
        .neq("id", interviewId)
        .in("status", PRIOR_OUTCOME_STATUSES)
        .order("interview_number", { ascending: false })
        .limit(MAX_PRIOR_INTERVIEWS);
      check("load prior interviews", error);
      if (!interviews?.length) {
        return [];
      }

      const { data: evaluations, error: evalError } = await serviceClient
        .from("evaluations")
        .select("interview_id, category, rating, strengths, gaps")
        .in("interview_id", interviews.map((i) => i.id));
      check("load prior evaluations", evalError);

      return interviews.map((interview) => {
        const state = (Array.isArray(interview.state) ? interview.state[0] : interview.state) as
          | { coverage_map: unknown }
          | null;
        const coverage = coverageMapSchema.safeParse(state?.coverage_map);
        const byCategory = new Map<string, PriorCategoryOutcome>();
        for (const e of evaluations ?? []) {
          if (e.interview_id !== interview.id) {
            continue;
          }
          const entry: PriorCategoryOutcome = byCategory.get(e.category) ??
            { category: e.category, ratings: [], strengths: [], gaps: [] };
          if (e.rating) {
            entry.ratings.push(e.rating);
          }
          entry.strengths.push(...strings(e.strengths));
          entry.gaps.push(...strings(e.gaps));
          byCategory.set(e.category, entry);
        }
        return {
          interview_number: interview.interview_number,
          status: interview.status,
          coverage: coverage.success
            ? coverage.data.areas.map(({ id, name, status }) => ({ id, name, status }))
            : [],
          categories: [...byCategory.values()].map((c) => ({
            category: c.category,
            ratings: c.ratings,
            strengths: priorItems(c.strengths),
            gaps: priorItems(c.gaps),
          })),
        };
      });
    },

    async markPlanningStage(jobId, progress, runId) {
      const { error } = await serviceClient
        .from("jobs")
        .update({
          status: "running",
          stage: "planning",
          progress,
          inngest_run_id: runId,
          started_at: new Date().toISOString(),
        })
        .eq("id", jobId)
        .in("status", ["queued", "running"]);
      check("record planning stage", error);
    },

    async completePlanning(interviewId, jobId, output) {
      let written = true;
      try {
        await updateInterviewState(serviceClient as unknown as InterviewStateRpcClient, interviewId, INITIAL_STATE_VERSION, {
          coverageMap: output.coverage_map,
          plan: output.plan,
          strategy: output.strategy,
        });
      } catch (err) {
        if (!(err instanceof StaleInterviewStateError)) {
          throw err;
        }
        written = false;
      }
      await markPlanningSucceeded(jobId);
      return written;
    },

    async failPlanning(jobId, code, message) {
      const { error } = await serviceClient
        .from("jobs")
        .update({ status: "failed", error_code: code, error_message: message, finished_at: new Date().toISOString() })
        .eq("id", jobId)
        .eq("type", "interview_planning")
        .neq("status", "succeeded");
      check("record planning failure", error);
    },
  };
}
