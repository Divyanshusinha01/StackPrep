/**
 * Drives the real `evaluateAnswer` tool over a scripted interview: the fake ToolStore holds the
 * transcript so far, the examined evidence and the interview state, exactly where the tool reads them.
 * After a successful evaluation the coverage update runs, as the tool handler does once the call is recorded.
 */
import type { EvaluateAnswerOutput, EvidenceExaminedPayload, InterviewPlanningOutput } from "@stackprep/shared";
import type { AIProvider } from "../../../../supabase/functions/_shared/ai/provider.ts";
import type { FakeToolStore } from "../../../../supabase/functions/interviews/testing.ts";
import { evaluateAnswer } from "../../../../supabase/functions/interviews/tools/evaluate-answer.ts";
import type { EvaluationRecord, ToolContext, TranscriptMessage } from "../../../../supabase/functions/interviews/tools/types.ts";
import type { PipelineMemory } from "./analysis.ts";
import { createCorpusToolStore, type IndexedCorpus } from "./corpus.ts";
import type { TaskModel } from "./planning.ts";
import { corpusToolContext } from "./search.ts";

export interface EvaluatedTurn {
  record: EvaluationRecord;
  /** What the voice model receives: guidance and the optional focus cue. */
  output: Extract<EvaluateAnswerOutput, { ok: true }>;
}

/** A fake store for one interview: pipeline memory, code index, and the interview state at version 1. */
export function interviewStore(corpus: IndexedCorpus, memory: PipelineMemory, state: InterviewPlanningOutput): FakeToolStore {
  return createCorpusToolStore(corpus, {
    memory: structuredClone(memory.all),
    state: { coverageMap: structuredClone(state.coverage_map), plan: structuredClone(state.plan), strategy: structuredClone(state.strategy), version: 1 },
  });
}

/** The ToolContext the evaluation tool runs in, with the given (recorded) provider and model settings. */
export function evaluationToolContext(corpus: IndexedCorpus, store: FakeToolStore, ai: AIProvider, task: TaskModel): ToolContext {
  return {
    ...corpusToolContext(corpus, store),
    ai,
    evaluationModel: task.model,
    evaluationReasoningEffort: task.reasoningEffort,
  };
}

/**
 * Evaluates the latest answer in `messages`. Null when the tool reported a failure (for example invalid
 * model output); other errors, including replay misses, propagate.
 */
export async function evaluateTurn(
  ctx: ToolContext & { store: FakeToolStore },
  messages: TranscriptMessage[],
  evidence: EvidenceExaminedPayload[],
  answerSummary: string,
): Promise<EvaluatedTurn | null> {
  ctx.store.messages = structuredClone(messages);
  ctx.store.evidence = structuredClone(evidence);
  const outcome = await evaluateAnswer(ctx, { answerSummary });
  if (!outcome.output.ok || !outcome.evaluation) return null;
  ctx.store.evaluations.push(outcome.evaluation);
  await outcome.afterRecord?.();
  return { record: outcome.evaluation, output: outcome.output as EvaluatedTurn["output"] };
}
