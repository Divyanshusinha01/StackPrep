/** Drives the real `runInterviewPlanning` over a corpus with an in-memory PlanningStore. */
import type { InterviewPlanningOutput } from "@stackprep/shared";
import type { AIProvider, ReasoningEffort } from "../../../../supabase/functions/_shared/ai/provider.ts";
import { runInterviewPlanning } from "../../../../supabase/functions/inngest/planning.ts";
import { INITIAL_STATE_VERSION, type PlanningStore } from "../../../../supabase/functions/inngest/planning-store.ts";
import type { PipelineMemory } from "./analysis.ts";
import { CORPUS_WORKSPACE_ID, type IndexedCorpus, stepRunner } from "./corpus.ts";

/** Model settings of one pipeline task, as production reads them from env. */
export interface TaskModel {
  model: string;
  reasoningEffort: ReasoningEffort;
}

export const EVAL_USER_ID = "e7a10000-0000-4000-8000-0000000000aa";
const PLANNING_JOB_ID = "e7a10000-0000-4000-8000-000000000010";
const PLANNING_INTERVIEW_ID = "e7a10000-0000-4000-8000-000000000011";

/** Plans an interview on the corpus; throws the production error (code as message) when planning fails. */
export async function runPlanning(
  corpus: IndexedCorpus,
  memory: PipelineMemory,
  ai: AIProvider,
  task: TaskModel,
): Promise<InterviewPlanningOutput> {
  let written: InterviewPlanningOutput | null = null;
  const done = () => Promise.resolve();
  const store: PlanningStore = {
    recordAiUsage: () => Promise.resolve("created"),
    loadPlanningTarget: () =>
      Promise.resolve({
        job_id: PLANNING_JOB_ID,
        job_status: "running",
        job_commit_sha: corpus.commitSha,
        user_id: EVAL_USER_ID,
        interview_id: PLANNING_INTERVIEW_ID,
        workspace_id: CORPUS_WORKSPACE_ID,
        interview_number: 1,
        interview_status: "created",
        commit_sha: corpus.commitSha,
        state_version: INITIAL_STATE_VERSION,
        repository_full_name: `eval/${corpus.id}`,
      }),
    loadMemory: () => Promise.resolve(structuredClone(memory.planning)),
    loadPriorOutcomes: () => Promise.resolve([]),
    markPlanningStage: done,
    completePlanning: (_i, _j, output) => {
      written = output;
      return Promise.resolve(true);
    },
    markPlanningSucceeded: done,
    failPlanning: done,
  };
  await runInterviewPlanning(
    { ai, model: task.model, reasoningEffort: task.reasoningEffort, store, log: () => {} },
    {
      data: { interview_id: PLANNING_INTERVIEW_ID, workspace_id: CORPUS_WORKSPACE_ID, job_id: PLANNING_JOB_ID, commit_sha: corpus.commitSha },
      runId: "eval",
      step: stepRunner,
    },
  );
  if (written === null) throw new Error("planning wrote no plan");
  return written;
}
