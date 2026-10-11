/**
 * Repository memory as the text pipeline reads it: the production baseline analysis
 * (`runRepositoryAnalysis`: tree scan, file facts, `buildRepositoryContext`) plus the code index rows,
 * ordered the way `repository_memory` reads return them. Kept apart from `IndexedCorpus.memory`, which
 * the retrieval suite scores and embeds, so adding summary rows here never changes retrieval numbers.
 */
import type { MemoryRow } from "../../../../supabase/functions/_shared/analysis/context.ts";
import { NON_SUMMARY_KIND_LIST } from "../../../../supabase/functions/_shared/code-index/memory.ts";
import { runRepositoryAnalysis } from "../../../../supabase/functions/inngest/function.ts";
import type { PlanningMemory } from "../../../../supabase/functions/inngest/planning-store.ts";
import type { AnalysisStore } from "../../../../supabase/functions/inngest/store.ts";
import type { MemoryEntry } from "../../../../supabase/functions/interviews/tools/types.ts";
import { CORPUS_WORKSPACE_ID, createCorpusGithub, type IndexedCorpus, stepRunner } from "./corpus.ts";

const ANALYSIS_JOB_ID = "e7a10000-0000-4000-8000-000000000003";
const REPOSITORY_ID = "e7a10000-0000-4000-8000-000000000004";
/** `loadMemory` (planning) and `loadReportContext` (report) cap file summaries at these counts. */
const PLANNING_FILE_SUMMARIES = 30;
const REPORT_FILE_SUMMARIES = 20;

export interface PipelineMemory {
  /** Every row, ordered like `listRepositoryMemory` (kind, then insertion: baseline before code index). */
  all: MemoryEntry[];
  /** What `PlanningStore.loadMemory` returns. */
  planning: PlanningMemory[];
  /** The memory part of `ReportContext`. */
  report: PlanningMemory[];
}

/** Runs the production baseline analysis over the corpus and returns the rows it would store. */
export async function analyzeCorpus(corpus: IndexedCorpus): Promise<MemoryRow[]> {
  let saved: MemoryRow[] | null = null;
  const none = () => Promise.resolve(null);
  const done = () => Promise.resolve();
  const store: AnalysisStore = {
    loadTarget: () =>
      Promise.resolve({
        job_id: ANALYSIS_JOB_ID,
        job_status: "running",
        job_commit_sha: corpus.commitSha,
        workspace_id: CORPUS_WORKSPACE_ID,
        repository_id: REPOSITORY_ID,
        target_commit_sha: corpus.commitSha,
        owner: "eval",
        name: corpus.id,
        installation_id: 1,
        suspended: false,
      }),
    countMemory: () => Promise.resolve(0),
    markStage: done,
    complete: (_w, _j, _c, memory) => {
      saved = memory;
      // Not ready: the follow-up jobs (deep analysis, code index, embeddings) are not queued.
      return Promise.resolve(false);
    },
    fail: done,
    requestDeepAnalysis: none,
    failDeepAnalysis: done,
    requestCodeIndex: none,
    failCodeIndex: done,
  };
  await runRepositoryAnalysis(
    {
      github: createCorpusGithub(corpus.files),
      store,
      jobs: { enqueue: () => Promise.resolve({ eventId: "eval" }) },
      log: () => {},
    },
    {
      data: {
        workspace_id: CORPUS_WORKSPACE_ID,
        repository_id: REPOSITORY_ID,
        job_id: ANALYSIS_JOB_ID,
        installation_id: 1,
        commit_sha: corpus.commitSha,
      },
      runId: "eval",
      step: stepRunner,
    },
  );
  if (saved === null) throw new Error(`corpus ${corpus.id}: the baseline analysis saved no memory`);
  return saved;
}

export async function pipelineMemory(corpus: IndexedCorpus): Promise<PipelineMemory> {
  const baseline = (await analyzeCorpus(corpus)).map((row) => ({ kind: row.kind, content: row.content, structured: row.structured }));
  const all = [...baseline, ...corpus.memory]
    .map((row, id) => ({ row, id }))
    .sort((a, b) => (a.row.kind < b.row.kind ? -1 : a.row.kind > b.row.kind ? 1 : a.id - b.id))
    .map(({ row }) => row);
  const summaries = all.filter((m) => !NON_SUMMARY_KIND_LIST.includes(m.kind));
  const files = all.filter((m) => m.kind === "file_summary");
  const ai = (m: MemoryEntry) => (m.structured as { ai?: unknown }).ai;
  return {
    all,
    planning: [
      ...summaries.map((m) => (ai(m) === undefined ? { kind: m.kind, content: m.content } : { kind: m.kind, content: m.content, ai: ai(m) })),
      ...files.slice(0, PLANNING_FILE_SUMMARIES).map((m) => ({ kind: m.kind, content: m.content })),
    ],
    report: [...summaries, ...files.slice(0, REPORT_FILE_SUMMARIES)].map((m) => ({ kind: m.kind, content: m.content })),
  };
}
