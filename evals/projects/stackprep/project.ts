/**
 * The StackPrep eval project. Run from the repository root:
 *   deno run -A --config supabase/functions/deno.json evals/projects/stackprep/project.ts run
 */
import { createCodeParser } from "@stackprep/code-parser";
import { REPOSITORY_MEMORY_EMBEDDING_DIMENSIONS } from "@stackprep/shared";
import { main } from "../../core/cli.ts";
import type { Project } from "../../core/types.ts";
import { DEFAULT_EMBEDDING_DECIMALS, openAIProviders, recordedEmbeddingProvider } from "./src/ai.ts";
import { claimsDatasetPins } from "./src/claims.ts";
import { type IndexedCorpus, loadIndexedCorpus } from "./src/corpus.ts";
import { CORPUS_DIRS, CORPUS_PINS, SNAPSHOT, SYNTHETIC } from "./src/corpus-source.ts";
import { embedCorpus, type MemoryVector } from "./src/search.ts";
import { type PipelineRun, type PipelineSettings, sessionsDatasetPins } from "./src/sessions.ts";
import { citationsSuite } from "./suites/citations.ts";
import { consistencyDatasetPins, consistencySuite } from "./suites/consistency.ts";
import { type ContradictionContext, contradictionDatasetPins, type ContradictionSettings, contradictionSuite } from "./suites/contradiction.ts";
import { type RetrievalContext, retrievalDatasetPins, retrievalSuite } from "./suites/retrieval.ts";
import { type SupportContext, type SupportSettings, supportSuite } from "./suites/support.ts";

export const PROJECT_DIR = new URL("./", import.meta.url);

/** Production model settings, as in supabase/functions/.env.example. */
const PIPELINE: PipelineSettings = {
  planning: { model: "gpt-6.1-sol", reasoningEffort: "medium" },
  evaluation: { model: "gpt-6-luna", reasoningEffort: "low" },
  report: { model: "gpt-6-luna", reasoningEffort: "low" },
};

/** The judge is the eval's own choice; below the floor its metrics are informational. */
const SUPPORT: SupportSettings = {
  judge: { model: "gpt-6.1-sol", reasoningEffort: "medium" },
  floor: { precision: 0.8, recall: 0.8, n: 30 },
};

/** Both contradiction judges have 30 human-labelled items each on the synthetic corpus. */
const CONTRADICTION: ContradictionSettings = {
  judge: { model: "gpt-6.1-sol", reasoningEffort: "medium" },
  floor: { precision: 0.8, recall: 0.8, n: 20 },
};

/** K: independent live evaluateAnswer samples per consistency transcript. */
export const CONSISTENCY_SAMPLES = 10;

export const CONFIG = {
  embedding: {
    model: "text-embedding-3-small",
    dimensions: REPOSITORY_MEMORY_EMBEDDING_DIMENSIONS,
    decimals: DEFAULT_EMBEDDING_DECIMALS,
  },
  retrieval: { limit: 5, ks: [1, 3, 5] },
  pipeline: PIPELINE,
  support: SUPPORT,
  contradiction: CONTRADICTION,
};

export type StackprepContext = RetrievalContext & SupportContext & ContradictionContext;

const corpusIds = Object.keys(CORPUS_DIRS);

export const project: Project<StackprepContext> = {
  id: "stackprep",
  pins: [
    ...CORPUS_PINS,
    ...retrievalDatasetPins(corpusIds),
    ...sessionsDatasetPins(corpusIds),
    ...claimsDatasetPins(corpusIds),
    ...consistencyDatasetPins(corpusIds),
    // Seeded contradictions exist only for the synthetic fixture; the snapshot has no planted flaws to seed from.
    ...contradictionDatasetPins([SYNTHETIC]),
    { id: "recordings", kind: "recordings", files: ["recordings"] },
  ],
  config: CONFIG,
  samples: CONSISTENCY_SAMPLES,
  async setup(env) {
    const parser = createCodeParser();
    const corpora = new Map<string, IndexedCorpus>();
    try {
      for (const id of corpusIds) {
        corpora.set(id, await loadIndexedCorpus(PROJECT_DIR, id, { parser }));
      }
    } finally {
      parser.dispose();
    }
    const live = env.mode === "replay" ? undefined : openAIProviders(Deno.env.get("OPENAI_API_KEY"));
    // Row embeddings are keyed on the setup recorder (corpus pins only), so editing a dataset never re-records them.
    const rowEmbeddings = recordedEmbeddingProvider(env.recorder, {
      provider: live?.embedding,
      site: "embedding.corpus",
      dimensions: CONFIG.embedding.dimensions,
      decimals: CONFIG.embedding.decimals,
    });
    const vectors = new Map<string, Promise<MemoryVector[]>>();
    return {
      projectDir: PROJECT_DIR,
      corpora,
      retrieval: { ...CONFIG.retrieval, embedding: CONFIG.embedding },
      liveEmbedding: live?.embedding,
      corpusVectors(corpusId) {
        const corpus = corpora.get(corpusId);
        if (!corpus) return Promise.reject(new Error(`corpus "${corpusId}" is not loaded`));
        if (!vectors.has(corpusId)) vectors.set(corpusId, embedCorpus(corpus, rowEmbeddings, CONFIG.embedding.model));
        return vectors.get(corpusId)!;
      },
      pipeline: CONFIG.pipeline,
      support: CONFIG.support,
      contradiction: CONFIG.contradiction,
      liveAI: live?.ai,
      pipelineRuns: new Map<string, Promise<PipelineRun>>(),
    };
  },
  suites: [
    retrievalSuite(SYNTHETIC, { gate: true }),
    retrievalSuite(SNAPSHOT, { gate: false }),
    citationsSuite(SYNTHETIC, { gate: true }),
    citationsSuite(SNAPSHOT, { gate: false }),
    supportSuite(SYNTHETIC, { gate: true }),
    supportSuite(SNAPSHOT, { gate: false }),
    consistencySuite(SYNTHETIC, { gate: true }),
    consistencySuite(SNAPSHOT, { gate: false }),
    contradictionSuite(SYNTHETIC, { gate: true }),
  ],
};

if (import.meta.main) {
  Deno.exit(await main(project, PROJECT_DIR, Deno.args));
}
