/**
 * Scripted interview sessions and the text pipeline run over them: one interview plan per corpus
 * (`runInterviewPlanning`), then per session every answer through `evaluateAnswer` and the finished
 * interview through `runInterviewReport`. All model calls go through the recorder, so replay needs no key.
 *
 * Evaluations and reports start from the dataset's hand-written interview state, not the recorded plan,
 * so re-recording the plan never invalidates evaluation or report recordings.
 *
 * Both text-surface suites (citations, support) read the same run: it is memoized per corpus and its
 * recorder is scoped to the corpus and sessions pins only, so both suites produce identical keys.
 */
import {
  type EvidenceExaminedPayload,
  type InterviewPlanningOutput,
  interviewPlanningOutputSchema,
} from "@stackprep/shared";
import type { AIProvider, StructuredRequest } from "../../../../supabase/functions/_shared/ai/provider.ts";
import type { TranscriptMessage } from "../../../../supabase/functions/interviews/tools/types.ts";
import { ReplayMissError } from "../../../core/recording.ts";
import type { PinSpec, Recorder, RunEnv } from "../../../core/types.ts";
import { recordedAIProvider } from "./ai.ts";
import { pipelineMemory } from "./analysis.ts";
import { lineCount } from "./citations.ts";
import type { IndexedCorpus } from "./corpus.ts";
import { type EvaluatedTurn, evaluateTurn, evaluationToolContext, interviewStore } from "./evaluate.ts";
import { runPlanning, type TaskModel } from "./planning.ts";
import { type ReportRun, runReport } from "./report.ts";

export const SESSIONS_DATASET_FORMAT = 1;
/** `evaluateAnswerInputSchema` bounds the interviewer's summary. */
const MAX_SUMMARY_CHARS = 1000;

export interface SessionEvidence {
  path: string;
  tool?: EvidenceExaminedPayload["tool"];
  symbol?: string;
  startLine?: number;
  endLine?: number;
}

export interface SessionTurn {
  question: string;
  answer: string;
  /** What the interviewer passes to evaluate_answer. */
  answer_summary: string;
  /** Evidence examined before this answer was given. */
  evidence?: SessionEvidence[];
}

export interface Session {
  id: string;
  description: string;
  turns: SessionTurn[];
}

export interface SessionsDataset {
  format: number;
  corpus: string;
  guidelines: string[];
  /** Interview state every session starts from, as planning would write it. */
  state: InterviewPlanningOutput;
  sessions: Session[];
}

export const sessionsPath = (corpusId: string) => `datasets/sessions/${corpusId}.json`;
export const sessionsPinId = (corpusId: string) => `dataset.sessions.${corpusId}`;

export function sessionsDatasetPins(corpusIds: readonly string[]): PinSpec[] {
  return corpusIds.map((id) => ({ id: sessionsPinId(id), kind: "dataset", files: [sessionsPath(id)] }));
}

/** Problems that make a sessions dataset unusable against this corpus; empty when it is valid. */
export function validateSessions(dataset: SessionsDataset, corpus: IndexedCorpus): string[] {
  const problems: string[] = [];
  if (dataset.format !== SESSIONS_DATASET_FORMAT) problems.push(`format must be ${SESSIONS_DATASET_FORMAT}`);
  if (dataset.corpus !== corpus.id) problems.push(`dataset is for corpus "${dataset.corpus}", not "${corpus.id}"`);
  const state = interviewPlanningOutputSchema.safeParse(dataset.state);
  if (!state.success) problems.push(`state is not a valid interview plan: ${state.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  if (!Array.isArray(dataset.sessions) || dataset.sessions.length === 0) return [...problems, "no sessions"];
  const ids = new Set<string>();
  for (const session of dataset.sessions) {
    const at = `session ${session.id}`;
    if (!session.id || !/^[a-z0-9-]+$/.test(session.id) || ids.has(session.id)) problems.push(`${at}: missing, malformed or duplicate id`);
    ids.add(session.id);
    if (!Array.isArray(session.turns) || session.turns.length === 0) {
      problems.push(`${at}: no turns`);
      continue;
    }
    session.turns.forEach((turn, i) => {
      const t = `${at} turn ${i + 1}`;
      for (const field of ["question", "answer"] as const) {
        if (typeof turn[field] !== "string" || !turn[field].trim()) problems.push(`${t}: empty ${field}`);
      }
      const summary = typeof turn.answer_summary === "string" ? turn.answer_summary.trim() : "";
      if (!summary || summary.length > MAX_SUMMARY_CHARS) problems.push(`${t}: answer_summary must be 1 to ${MAX_SUMMARY_CHARS} characters`);
      for (const e of turn.evidence ?? []) {
        const text = corpus.files.get(e.path);
        if (text === undefined) {
          problems.push(`${t}: evidence "${e.path}" is not in the corpus`);
          continue;
        }
        if ((e.startLine === undefined) !== (e.endLine === undefined)) problems.push(`${t}: evidence "${e.path}" needs both startLine and endLine`);
        if (e.startLine !== undefined && e.endLine !== undefined && !(e.startLine >= 1 && e.startLine <= e.endLine && e.endLine <= lineCount(text))) {
          problems.push(`${t}: evidence "${e.path}" lines ${e.startLine}-${e.endLine} are outside the file`);
        }
      }
    });
  }
  return problems;
}

export async function loadSessions(projectDir: URL, corpus: IndexedCorpus): Promise<SessionsDataset> {
  const path = sessionsPath(corpus.id);
  const dataset = JSON.parse(await Deno.readTextFile(new URL(path, projectDir))) as SessionsDataset;
  const problems = validateSessions(dataset, corpus);
  if (problems.length > 0) throw new Error(`${path}: ${problems.join("; ")}`);
  return dataset;
}

export interface PipelineSettings {
  planning: TaskModel;
  evaluation: TaskModel;
  report: TaskModel;
}

/** What the text-surface suites need from the project context. */
export interface PipelineContext {
  projectDir: URL;
  corpora: ReadonlyMap<string, IndexedCorpus>;
  pipeline: PipelineSettings;
  /** Real model provider in record and live modes; undefined in replay. */
  liveAI?: AIProvider;
  /** Memoized runs per corpus id. */
  pipelineRuns: Map<string, Promise<PipelineRun>>;
}

export type PipelineStage = "plan" | "evaluation" | "report";

export interface PipelineProblem {
  at: string;
  stage: PipelineStage;
  /** not_recorded: replay had no recording; failed: production reported a failure (for example invalid output). */
  reason: "not_recorded" | "failed";
  detail: string;
}

export interface TurnRun {
  /** The interviewer message the answer replies to. */
  questionId: string;
  evaluation: EvaluatedTurn | null;
}

export interface SessionRun {
  id: string;
  /** Evaluated turns in order; stops at the first turn that is not recorded. */
  turns: TurnRun[];
  report: ReportRun | null;
}

export interface PipelineRun {
  corpusId: string;
  plan: InterviewPlanningOutput | null;
  sessions: SessionRun[];
  problems: PipelineProblem[];
  /** Some outputs were not recorded, so the run covers only part of the dataset. */
  partial: boolean;
}

/** A recorder injecting only the named pins when the recorder supports scoping (the core FileRecorder does). */
export function scopedRecorder(recorder: Recorder, pins: string[]): Recorder {
  const forPins = (recorder as Recorder & { forPins?: (ids: string[]) => Recorder }).forPins;
  return typeof forPins === "function" ? forPins(pins) : recorder;
}

/** Notes replay misses, which production code wraps into its own error codes. */
function missTracking(provider: AIProvider): AIProvider & { missed: boolean } {
  const tracked = {
    missed: false,
    async generateStructured<T>(request: StructuredRequest<T>) {
      try {
        return await provider.generateStructured(request);
      } catch (err) {
        if (err instanceof ReplayMissError) tracked.missed = true;
        throw err;
      }
    },
  };
  return tracked;
}

export function sessionMessages(session: Session): TranscriptMessage[] {
  return session.turns.flatMap((turn, i) => [
    { id: `${session.id}-q${i + 1}`, sequence: 2 * i + 1, role: "ai" as const, content: turn.question },
    { id: `${session.id}-a${i + 1}`, sequence: 2 * i + 2, role: "user" as const, content: turn.answer },
  ]);
}

/** Evidence examined up to and including turn `index` (0-based), first examination of each path only. */
export function evidenceThrough(session: Session, index: number): EvidenceExaminedPayload[] {
  const evidence: EvidenceExaminedPayload[] = [];
  for (const turn of session.turns.slice(0, index + 1)) {
    for (const e of turn.evidence ?? []) {
      if (evidence.some((x) => x.path === e.path)) continue;
      evidence.push({
        path: e.path,
        tool: e.tool ?? "get_file",
        ...(e.symbol ? { symbol: e.symbol } : {}),
        ...(e.startLine !== undefined && e.endLine !== undefined ? { startLine: e.startLine, endLine: e.endLine } : {}),
      });
    }
  }
  return evidence;
}

/** The text pipeline over a corpus's sessions dataset, memoized in the context. */
export function pipelineRun(ctx: PipelineContext, corpusId: string, env: RunEnv): Promise<PipelineRun> {
  let run = ctx.pipelineRuns.get(corpusId);
  if (!run) {
    run = runPipeline(ctx, corpusId, scopedRecorder(env.recorder, [corpusId, sessionsPinId(corpusId)]), env.log);
    ctx.pipelineRuns.set(corpusId, run);
  }
  return run;
}

async function runPipeline(ctx: PipelineContext, corpusId: string, recorder: Recorder, log: (line: string) => void): Promise<PipelineRun> {
  const corpus = ctx.corpora.get(corpusId);
  if (!corpus) throw new Error(`corpus "${corpusId}" is not loaded`);
  const dataset = await loadSessions(ctx.projectDir, corpus);
  const memory = await pipelineMemory(corpus);
  const problems: PipelineProblem[] = [];
  const provider = () => missTracking(recordedAIProvider(recorder, { provider: ctx.liveAI }));
  /** Runs one stage; on failure records the problem and returns null. */
  const attempt = async <T>(at: string, stage: PipelineStage, fn: (ai: AIProvider) => Promise<T>): Promise<T | null> => {
    const ai = provider();
    try {
      return await fn(ai);
    } catch (err) {
      // Planning and report map every error to a fixed code, so a miss is known only from the tracker.
      const detail = ai.missed ? "no recording" : err instanceof Error ? err.message : String(err);
      problems.push({ at, stage, reason: ai.missed ? "not_recorded" : "failed", detail });
      return null;
    }
  };

  log(`pipeline ${corpusId}: plan`);
  const plan = await attempt("plan", "plan", (ai) => runPlanning(corpus, memory, ai, ctx.pipeline.planning));

  const sessions: SessionRun[] = [];
  for (const [index, session] of dataset.sessions.entries()) {
    log(`pipeline ${corpusId}: session ${session.id}`);
    const messages = sessionMessages(session);
    const store = interviewStore(corpus, memory, dataset.state);
    let evidence: EvidenceExaminedPayload[] = [];
    const turns: TurnRun[] = [];
    let complete = true;
    for (const [i, turn] of session.turns.entries()) {
      evidence = evidenceThrough(session, i);
      const ai = provider();
      const at = `${session.id}/q${i + 1}`;
      try {
        const evaluation = await evaluateTurn(
          { ...evaluationToolContext(corpus, store, ai, ctx.pipeline.evaluation), store },
          messages.slice(0, 2 * i + 2),
          evidence,
          turn.answer_summary,
        );
        if (evaluation === null) problems.push({ at, stage: "evaluation", reason: "failed", detail: "evaluate_answer returned a failure" });
        turns.push({ questionId: messages[2 * i].id, evaluation });
      } catch (err) {
        if (!(err instanceof ReplayMissError)) throw err;
        problems.push({ at, stage: "evaluation", reason: "not_recorded", detail: "no recording; later turns and the report depend on it and were skipped" });
        complete = false;
        break;
      }
    }
    let report: ReportRun | null = null;
    if (complete) {
      const coverage = (store.state?.coverageMap ?? dataset.state.coverage_map) as InterviewPlanningOutput["coverage_map"];
      report = await attempt(`${session.id}/report`, "report", (ai) =>
        runReport(corpus, memory, ai, ctx.pipeline.report, {
          index: index + 1,
          messages,
          evaluations: store.evaluations,
          evidence,
          coverage,
        }));
    }
    sessions.push({ id: session.id, turns, report });
  }
  return { corpusId, plan, sessions, problems, partial: problems.some((p) => p.reason === "not_recorded") };
}
