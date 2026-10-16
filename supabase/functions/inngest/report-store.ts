import {
  coverageMapSchema,
  type InterviewStatus,
  type LearningReport,
  type ReportErrorCode,
} from "@stackprep/shared";
import type { SupabaseClient } from "@supabase/supabase-js";
import { type AiUsageRecorder, createAiUsageRecorder } from "../_shared/ai-usage.ts";
import { NON_SUMMARY_KINDS } from "../_shared/code-index/memory.ts";
import { createPlanningStore, type PlanningMemory, type PriorOutcome } from "./planning-store.ts";

const MAX_MESSAGES = 400;
const MAX_EVIDENCE = 100;
const MAX_FILE_SUMMARIES = 20;

export type ReportJobStatus = "queued" | "running" | "succeeded" | "failed";

export interface ReportTarget {
  job_id: string;
  job_status: ReportJobStatus;
  user_id: string;
  interview_id: string;
  workspace_id: string;
  interview_number: number;
  interview_status: InterviewStatus;
  /** The interview's pinned commit. */
  commit_sha: string;
  repository_full_name: string;
}

export interface ReportMessage {
  id: string;
  sequence: number;
  role: "ai" | "user" | "system";
  content: string;
}

/** One hidden `evaluations` row; `message_id` is the question that was answered. */
export interface ReportEvaluation {
  message_id: string;
  category: string;
  /** 1-5, recorded during the interview; null for rows without one. */
  score: number | null;
  rating: string | null;
  strengths: string[];
  gaps: string[];
  repo_evidence: string[];
  discrepancy: boolean;
}

export interface ReportEvidence {
  path: string;
  area: string | null;
  /** Symbol-level trace, when the examination was of one symbol or line range. */
  symbol?: string;
  startLine?: number;
  endLine?: number;
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export interface ReportCoverage {
  id: string;
  name: string;
  status: string;
}

/** Everything the report is generated from, read from PostgreSQL only. */
export interface ReportContext {
  messages: ReportMessage[];
  evaluations: ReportEvaluation[];
  evidence: ReportEvidence[];
  memory: PlanningMemory[];
  coverage: ReportCoverage[];
  /** Earlier interviews in the same workspace. */
  prior: PriorOutcome[];
}

/** Service-role persistence for the report run. Every call is keyed by job or interview id. */
export interface ReportStore extends AiUsageRecorder {
  /** Job, interview, and repository, resolved together; null if any is missing. */
  loadReportTarget(jobId: string): Promise<ReportTarget | null>;
  loadReportContext(target: ReportTarget): Promise<ReportContext>;
  markReportStage(jobId: string, progress: number, runId: string): Promise<void>;
  /** Upserts the report and marks the job succeeded in one transaction (`save_report`). */
  saveReport(interviewId: string, jobId: string, report: LearningReport): Promise<void>;
  failReport(jobId: string, code: ReportErrorCode, message: string): Promise<void>;
}

function check(action: string, error: { message: string } | null): void {
  if (error) {
    throw new Error(`Failed to ${action}: ${error.message}`);
  }
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export function createReportStore(serviceClient: SupabaseClient): ReportStore {
  const planning = createPlanningStore(serviceClient);

  return {
    ...createAiUsageRecorder(serviceClient),

    async loadReportTarget(jobId) {
      const { data: job, error } = await serviceClient
        .from("jobs")
        .select("id, status, user_id, interview_id, workspace_id")
        .eq("id", jobId)
        .eq("type", "report_generation")
        .maybeSingle();
      check("load report job", error);
      if (!job?.interview_id) {
        return null;
      }

      const [interview, workspace] = await Promise.all([
        serviceClient.from("interviews")
          .select("id, workspace_id, interview_number, status, repository_commit_sha")
          .eq("id", job.interview_id).eq("workspace_id", job.workspace_id).maybeSingle(),
        serviceClient.from("workspaces")
          .select("id, repository:repositories!workspaces_repository_id_user_id_fkey(full_name)")
          .eq("id", job.workspace_id).maybeSingle(),
      ]);
      check("load interview", interview.error);
      check("load workspace", workspace.error);
      const repository = workspace.data?.repository as unknown as { full_name: string } | null | undefined;
      if (!interview.data || !repository) {
        return null;
      }
      return {
        job_id: job.id,
        job_status: job.status,
        user_id: job.user_id,
        interview_id: interview.data.id,
        workspace_id: interview.data.workspace_id,
        interview_number: interview.data.interview_number,
        interview_status: interview.data.status,
        commit_sha: interview.data.repository_commit_sha,
        repository_full_name: repository.full_name,
      };
    },

    async loadReportContext(target) {
      const id = target.interview_id;
      const memory = () =>
        serviceClient.from("repository_memory").select("kind, content")
          .eq("workspace_id", target.workspace_id).eq("repository_commit_sha", target.commit_sha);
      const [messages, evaluations, evidence, state, summaries, files, prior] = await Promise.all([
        serviceClient.from("interview_messages").select("id, sequence, role, content")
          .eq("interview_id", id).order("sequence").limit(MAX_MESSAGES),
        serviceClient.from("evaluations")
          .select("message_id, category, score, rating, strengths, gaps, repo_evidence, discrepancy")
          .eq("interview_id", id).order("created_at"),
        serviceClient.from("interview_events").select("payload")
          .eq("interview_id", id).eq("event_type", "evidence_examined").order("sequence").limit(MAX_EVIDENCE),
        serviceClient.from("interview_state").select("coverage_map").eq("interview_id", id).maybeSingle(),
        memory().not("kind", "in", NON_SUMMARY_KINDS).order("kind"),
        memory().eq("kind", "file_summary").order("created_at").limit(MAX_FILE_SUMMARIES),
        planning.loadPriorOutcomes(target.workspace_id, id),
      ]);
      check("load transcript", messages.error);
      check("load evaluations", evaluations.error);
      check("load evidence", evidence.error);
      check("load interview state", state.error);
      check("load repository memory", summaries.error);
      check("load file summaries", files.error);

      const coverage = coverageMapSchema.safeParse(state.data?.coverage_map);
      return {
        messages: (messages.data ?? []) as ReportMessage[],
        evaluations: (evaluations.data ?? []).map((e) => ({
          message_id: e.message_id,
          category: e.category,
          score: typeof e.score === "number" ? e.score : null,
          rating: e.rating,
          strengths: strings(e.strengths),
          gaps: strings(e.gaps),
          repo_evidence: strings(e.repo_evidence),
          discrepancy: e.discrepancy === true,
        })),
        evidence: (evidence.data ?? []).flatMap((row) => {
          const payload = row.payload as { path?: unknown; area?: unknown; symbol?: unknown; startLine?: unknown; endLine?: unknown };
          if (typeof payload.path !== "string") {
            return [];
          }
          const startLine = positiveInt(payload.startLine);
          const endLine = positiveInt(payload.endLine);
          return [{
            path: payload.path,
            area: typeof payload.area === "string" ? payload.area : null,
            ...(typeof payload.symbol === "string" ? { symbol: payload.symbol } : {}),
            ...(startLine !== undefined && endLine !== undefined && endLine >= startLine ? { startLine, endLine } : {}),
          }];
        }),
        memory: [...(summaries.data ?? []), ...(files.data ?? [])] as PlanningMemory[],
        coverage: coverage.success ? coverage.data.areas.map(({ id, name, status }) => ({ id, name, status })) : [],
        prior: prior.filter((p) => p.interview_number < target.interview_number),
      };
    },

    async markReportStage(jobId, progress, runId) {
      const { error } = await serviceClient
        .from("jobs")
        .update({
          status: "running",
          stage: "reporting",
          progress,
          inngest_run_id: runId,
          started_at: new Date().toISOString(),
        })
        .eq("id", jobId)
        .in("status", ["queued", "running"]);
      check("record report stage", error);
    },

    async saveReport(interviewId, jobId, report) {
      const { error } = await serviceClient.rpc("save_report", {
        p_interview_id: interviewId,
        p_job_id: jobId,
        p_content: report,
      });
      check("save report", error);
    },

    async failReport(jobId, code, message) {
      const { error } = await serviceClient
        .from("jobs")
        .update({ status: "failed", error_code: code, error_message: message, finished_at: new Date().toISOString() })
        .eq("id", jobId)
        .eq("type", "report_generation")
        .neq("status", "succeeded");
      check("record report failure", error);
    },
  };
}
