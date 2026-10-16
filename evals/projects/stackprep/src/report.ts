/**
 * Drives the real `runInterviewReport` with an in-memory ReportStore and a pass-through step runner, so
 * production prompt, limits and `groundReport` all apply. The model's output before grounding is
 * captured too, to show what `groundReport` filters.
 */
import type { InterviewPlanningOutput, LearningReport } from "@stackprep/shared";
import type { AIProvider, StructuredRequest } from "../../../../supabase/functions/_shared/ai/provider.ts";
import { createFakeOpenAIClients, fakeUserOpenAIClients } from "../../../../supabase/functions/_shared/testing.ts";
import type { LearningReportModelOutput } from "../../../../supabase/functions/inngest/report-learning.ts";
import { REPORT_SCHEMA_NAME, runInterviewReport } from "../../../../supabase/functions/inngest/report.ts";
import type { ReportContext, ReportEvidence, ReportStore } from "../../../../supabase/functions/inngest/report-store.ts";
import { type EvaluationRecord, topLevelArea, type TranscriptMessage } from "../../../../supabase/functions/interviews/tools/types.ts";
import type { PipelineMemory } from "./analysis.ts";
import { CORPUS_WORKSPACE_ID, type IndexedCorpus, stepRunner } from "./corpus.ts";
import { EVAL_USER_ID, type TaskModel } from "./planning.ts";

export interface ReportRun {
  /** What the model returned, before `groundReport` and hydration. */
  ungrounded: LearningReportModelOutput;
  /** What production saves. No web search runs here, so every concept's resources are unavailable. */
  grounded: LearningReport;
  context: ReportContext;
}

export interface ReportInput {
  /** Stable per interview; becomes the interview and job ids. */
  index: number;
  messages: TranscriptMessage[];
  evaluations: EvaluationRecord[];
  evidence: Array<{ path: string; symbol?: string; startLine?: number; endLine?: number }>;
  /** Coverage after the interview (statuses raised by the evaluations). */
  coverage: InterviewPlanningOutput["coverage_map"];
}

const uuid = (kind: number, index: number) => `e7a10000-0000-4000-8000-${kind.toString(16).padStart(4, "0")}${index.toString(16).padStart(8, "0")}`;

/**
 * The context `loadReportContext` would read for this interview. Session message ids are readable
 * labels; reports key question reviews by transcript UUID, so each label maps to a stable UUID.
 */
export function reportContext(memory: PipelineMemory, input: ReportInput): ReportContext {
  const messageIds = new Map(input.messages.map((m, i) => [m.id, uuid(3, input.index * 1000 + i)]));
  const messageId = (id: string) => messageIds.get(id) ?? id;
  const evidence: ReportEvidence[] = input.evidence.map((e) => ({
    path: e.path,
    area: topLevelArea(e.path) ?? null,
    ...(e.symbol ? { symbol: e.symbol } : {}),
    ...(e.startLine !== undefined && e.endLine !== undefined && e.endLine >= e.startLine ? { startLine: e.startLine, endLine: e.endLine } : {}),
  }));
  return {
    messages: input.messages.map(({ id, sequence, role, content }) => ({ id: messageId(id), sequence, role, content })),
    evaluations: input.evaluations.map((e) => ({
      message_id: messageId(e.message_id),
      category: e.category,
      score: e.score,
      rating: e.rating,
      strengths: e.strengths,
      gaps: e.gaps,
      repo_evidence: e.repo_evidence,
      discrepancy: e.discrepancy,
    })),
    evidence,
    memory: structuredClone(memory.report),
    coverage: input.coverage.areas.map(({ id, name, status }) => ({ id, name, status })),
    prior: [],
  };
}

/** Generates the report; throws the production error (code as message) when generation fails. */
export async function runReport(
  corpus: IndexedCorpus,
  memory: PipelineMemory,
  ai: AIProvider,
  task: TaskModel,
  input: ReportInput,
): Promise<ReportRun> {
  const ids = { interview_id: uuid(1, input.index), workspace_id: CORPUS_WORKSPACE_ID, job_id: uuid(2, input.index) };
  const context = reportContext(memory, input);
  let ungrounded: LearningReportModelOutput | null = null;
  let grounded: LearningReport | null = null;
  const capturing: AIProvider = {
    async generateStructured<T>(request: StructuredRequest<T>) {
      const result = await ai.generateStructured(request);
      if (request.schemaName === REPORT_SCHEMA_NAME) {
        ungrounded = structuredClone(result.output) as LearningReportModelOutput;
      }
      return result;
    },
  };
  const done = () => Promise.resolve();
  const store: ReportStore = {
    recordAiUsage: () => Promise.resolve("created"),
    loadReportTarget: () =>
      Promise.resolve({
        job_id: ids.job_id,
        job_status: "running",
        user_id: EVAL_USER_ID,
        interview_id: ids.interview_id,
        workspace_id: ids.workspace_id,
        interview_number: 1,
        interview_status: "completed",
        commit_sha: corpus.commitSha,
        repository_full_name: `eval/${corpus.id}`,
      }),
    loadReportContext: () => Promise.resolve(structuredClone(context)),
    markReportStage: done,
    saveReport: (_i, _j, report) => {
      grounded = report;
      return Promise.resolve();
    },
    failReport: done,
  };
  await runInterviewReport(
    {
      openai: createFakeOpenAIClients(EVAL_USER_ID, fakeUserOpenAIClients({ ai: capturing })),
      model: task.model,
      reasoningEffort: task.reasoningEffort,
      store,
      log: () => {},
    },
    { data: ids, runId: "eval", step: stepRunner },
  );
  if (ungrounded === null || grounded === null) throw new Error("the report run saved no report");
  return { ungrounded, grounded, context };
}
