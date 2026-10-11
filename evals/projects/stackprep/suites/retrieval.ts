/**
 * Retrieval quality on one corpus: labelled queries through the real `searchRepository` in the keyword,
 * +symbol and hybrid configurations, scored as precision, recall and MRR at each k with seeded bootstrap
 * intervals, overall, per query type, and on the indexable slice (labels the index can return at all).
 * Each corpus is its own suite, so its metrics never mix with the other corpus.
 */
import type { EmbeddingProvider } from "../../../../supabase/functions/_shared/ai/provider.ts";
import { ReplayMissError } from "../../../core/recording.ts";
import { bootstrapCI, type RankedCase, rankingMetrics } from "../../../core/stats.ts";
import type { Metric, PinSpec, RunEnv, Suite, SuiteResult } from "../../../core/types.ts";
import { recordedEmbeddingProvider } from "../src/ai.ts";
import type { IndexedCorpus } from "../src/corpus.ts";
import { CONFIG_LABELS, type MemoryVector, RETRIEVAL_CONFIGS, type RetrievalConfig, runSearch, type SearchRun } from "../src/search.ts";

export const RETRIEVAL_DATASET_FORMAT = 1;
export const QUERY_TYPES = ["exact", "paraphrase", "concept"] as const;
export type QueryType = typeof QUERY_TYPES[number];
/** `searchRepositoryInputSchema` caps queries at this length. */
const MAX_QUERY_CHARS = 200;

export interface RetrievalQuery {
  id: string;
  type: QueryType;
  query: string;
  /** Repository file paths, or module directories ending in "/". */
  relevant: string[];
}

export interface RetrievalDataset {
  format: number;
  corpus: string;
  guidelines: string[];
  queries: RetrievalQuery[];
}

export interface RetrievalSettings {
  /** The `limit` passed to search_repository; production's default. */
  limit: number;
  ks: number[];
  embedding: { model: string; dimensions: number; decimals: number };
}

/** What the retrieval suites need from the project context. */
export interface RetrievalContext {
  projectDir: URL;
  corpora: ReadonlyMap<string, IndexedCorpus>;
  retrieval: RetrievalSettings;
  /** Real embedding provider in record and live modes; undefined in replay. */
  liveEmbedding?: EmbeddingProvider;
  /** Embedded memory rows of a corpus; rejects with ReplayMissError when they are not recorded. */
  corpusVectors(corpusId: string): Promise<MemoryVector[]>;
}

export const datasetPath = (corpusId: string) => `datasets/retrieval/${corpusId}.json`;
export const datasetPinId = (corpusId: string) => `dataset.retrieval.${corpusId}`;

export function retrievalDatasetPins(corpusIds: readonly string[]): PinSpec[] {
  return corpusIds.map((id) => ({ id: datasetPinId(id), kind: "dataset", files: [datasetPath(id)] }));
}

/** Problems that make a dataset unusable against this corpus; empty when it is valid. */
export function validateDataset(dataset: RetrievalDataset, corpus: IndexedCorpus): string[] {
  const problems: string[] = [];
  if (dataset.format !== RETRIEVAL_DATASET_FORMAT) problems.push(`format must be ${RETRIEVAL_DATASET_FORMAT}`);
  if (dataset.corpus !== corpus.id) problems.push(`dataset is for corpus "${dataset.corpus}", not "${corpus.id}"`);
  if (!Array.isArray(dataset.queries) || dataset.queries.length === 0) return [...problems, "no queries"];
  const paths = [...corpus.files.keys()];
  const ids = new Set<string>();
  for (const q of dataset.queries) {
    const at = `query ${q.id}`;
    if (!q.id || ids.has(q.id)) problems.push(`${at}: missing or duplicate id`);
    ids.add(q.id);
    if (!QUERY_TYPES.includes(q.type)) problems.push(`${at}: type must be one of ${QUERY_TYPES.join(", ")}`);
    const text = typeof q.query === "string" ? q.query.trim() : "";
    if (text.length === 0 || text.length > MAX_QUERY_CHARS) problems.push(`${at}: query must be 1 to ${MAX_QUERY_CHARS} characters`);
    if (!Array.isArray(q.relevant) || q.relevant.length === 0) {
      problems.push(`${at}: no relevant paths (unlabelled)`);
      continue;
    }
    if (new Set(q.relevant).size !== q.relevant.length) problems.push(`${at}: duplicate relevant paths`);
    for (const path of q.relevant) {
      const exists = path.endsWith("/") ? paths.some((p) => p.startsWith(path)) : corpus.files.has(path);
      if (!exists) problems.push(`${at}: "${path}" is not in the corpus`);
    }
  }
  return problems;
}

export async function loadRetrievalDataset(projectDir: URL, corpus: IndexedCorpus): Promise<RetrievalDataset> {
  const path = datasetPath(corpus.id);
  const dataset = JSON.parse(await Deno.readTextFile(new URL(path, projectDir))) as RetrievalDataset;
  const problems = validateDataset(dataset, corpus);
  if (problems.length > 0) throw new Error(`${path}: ${problems.join("; ")}`);
  return dataset;
}

/** A labelled file the production secret check withheld from the index, so no configuration can return it. */
function withheld(corpus: IndexedCorpus, path: string): boolean {
  return !path.endsWith("/") && Object.hasOwn(corpus.summary.unindexed, path);
}

function indexable(corpus: IndexedCorpus, relevant: readonly string[]): string[] {
  return relevant.filter((path) => !withheld(corpus, path));
}

/** Wraps a provider to note replay misses, which `searchRepository` swallows into a keyword fallback. */
function missTracking(provider: EmbeddingProvider): EmbeddingProvider & { missed: boolean } {
  const tracked = {
    missed: false,
    async embed(request: Parameters<EmbeddingProvider["embed"]>[0]) {
      try {
        return await provider.embed(request);
      } catch (err) {
        if (err instanceof ReplayMissError) tracked.missed = true;
        throw err;
      }
    },
  };
  return tracked;
}

interface Measured {
  config: RetrievalConfig;
  runs: SearchRun[];
}

export interface RetrievalSuiteOptions {
  /** Whether the overall metrics at the largest k gate CI. Everything else is informational. */
  gate: boolean;
}

export function retrievalSuite(corpusId: string, options: RetrievalSuiteOptions): Suite<RetrievalContext> {
  return {
    id: `retrieval-${corpusId}`,
    pins: [corpusId, datasetPinId(corpusId)],
    run: (ctx, env) => runRetrieval(ctx, env, corpusId, options),
  };
}

async function runRetrieval(ctx: RetrievalContext, env: RunEnv, corpusId: string, options: RetrievalSuiteOptions): Promise<SuiteResult> {
  const corpus = ctx.corpora.get(corpusId);
  if (!corpus) throw new Error(`corpus "${corpusId}" is not loaded`);
  const dataset = await loadRetrievalDataset(ctx.projectDir, corpus);
  const { limit, ks, embedding } = ctx.retrieval;
  const caveats: string[] = [];

  let vectors: MemoryVector[] = [];
  let vectorsMissing = false;
  try {
    vectors = await ctx.corpusVectors(corpusId);
  } catch (err) {
    if (!(err instanceof ReplayMissError)) throw err;
    vectorsMissing = true;
  }
  const queryProvider = missTracking(recordedEmbeddingProvider(env.recorder, {
    provider: ctx.liveEmbedding,
    site: "embedding.query",
    dimensions: embedding.dimensions,
    decimals: embedding.decimals,
  }));

  const measured: Measured[] = [];
  for (const config of RETRIEVAL_CONFIGS) {
    const runs: SearchRun[] = [];
    for (const q of dataset.queries) {
      runs.push(await runSearch(corpus, config, q.query, {
        limit,
        ...(config === "hybrid" ? { vectors, queryEmbeddings: { provider: queryProvider, model: embedding.model } } : {}),
      }));
    }
    if (config === "hybrid") {
      if (vectorsMissing || queryProvider.missed) {
        caveats.push(
          `hybrid not measured: ${vectorsMissing ? "corpus row" : "query"} embeddings are not recorded; run "eval record" with OPENAI_API_KEY, then re-pin recordings.`,
        );
        continue;
      }
      const failed = runs.findIndex((r) => r.fallback !== undefined);
      if (failed !== -1) {
        throw new Error(`hybrid vector fill fell back (${runs[failed].fallback}) for query ${dataset.queries[failed].id}`);
      }
      const filled = runs.filter((r) => r.vectorFilled).length;
      caveats.push(
        `The vector fill runs only when keyword and symbol hits are fewer than limit ${limit}; it ran for ${filled} of ${runs.length} queries, so hybrid can differ from +symbol only on those.`,
        "The vector fill de-duplicates by path and area, and every vector hit is path \".\" with its memory kind as area, so it adds at most one hit per kind (here file_summary and code_module) however many slots are free.",
      );
    }
    measured.push({ config, runs });
  }

  const metrics = measured.flatMap(({ config, runs }) => configMetrics(corpus, dataset, config, runs, ks, env.seed, options.gate));

  const affected = dataset.queries.filter((q) => q.relevant.some((p) => withheld(corpus, p)));
  if (affected.length > 0) {
    const files = [...new Set(affected.flatMap((q) => q.relevant.filter((p) => withheld(corpus, p))))].sort();
    caveats.push(
      `${affected.length} of ${dataset.queries.length} queries label files the production secret check withholds from the index (${files.join(", ")}); no configuration can return them. The "indexable" slice scores without them.`,
    );
  }
  caveats.push(
    "Row-level vector hits (path \".\") are credited to the file or module named on their excerpt's first line; production returns them without a path and records no evidence for them.",
    "Offline limits: symbol ranking is the fake store's in-memory ranking, not the search_code_symbols SQL, and the cosine match is exact, not the pgvector index.",
    "Memory holds code index rows only (code_module, file_summary); the AI-generated memory rows of a real analysis are absent.",
  );

  const cases = dataset.queries.map((q, i) => {
    const ranks = measured.map(({ config, runs }) => {
      const at = runs[i].ranked.slice(0, Math.max(...ks)).findIndex((id) => q.relevant.includes(id));
      return `${CONFIG_LABELS[config]} ${at === -1 ? "-" : `#${at + 1}`}`;
    });
    const best = measured.at(-1)!.runs[i].ranked.slice(0, Math.max(...ks));
    return {
      id: q.id,
      ok: best.some((id) => q.relevant.includes(id)),
      detail: `${q.type}: ${ranks.join(", ")}; relevant ${q.relevant.join(", ")}`,
    };
  });
  return { metrics, cases, caveats };
}

function configMetrics(
  corpus: IndexedCorpus,
  dataset: RetrievalDataset,
  config: RetrievalConfig,
  runs: SearchRun[],
  ks: number[],
  seed: number,
  gate: boolean,
): Metric[] {
  const maxK = Math.max(...ks);
  const base = (id: string, label: string, values: number[], gated: boolean): Metric => ({
    id: `retrieval.${corpus.id}.${config}.${id}`,
    label: `${label} (${corpus.id}, ${CONFIG_LABELS[config]})`,
    value: values.reduce((a, b) => a + b, 0) / values.length,
    n: values.length,
    ci: bootstrapCI(values, { seed }),
    direction: "higher_is_better",
    provenance: "deterministic",
    corpus: corpus.id,
    gate: gated,
    ...(config === "hybrid" ? { note: "query and row embeddings replayed from recordings; vector hits credited to the file their excerpt names" } : {}),
  });

  const all: RankedCase[] = dataset.queries.map((q, i) => ({ ranked: runs[i].ranked, relevant: q.relevant }));
  const out: Metric[] = [];
  for (const r of rankingMetrics(all, ks)) {
    const gated = gate && r.k === maxK;
    out.push(
      base(`precision_at_${r.k}`, `Precision@${r.k}`, r.perCase.precision, gated),
      base(`recall_at_${r.k}`, `Recall@${r.k}`, r.perCase.recall, gated),
      base(`mrr_at_${r.k}`, `MRR@${r.k}`, r.perCase.reciprocalRank, gated),
    );
  }

  const slices: Array<[string, RankedCase[]]> = QUERY_TYPES.map((type) => [
    type,
    dataset.queries.flatMap((q, i) => (q.type === type ? [all[i]] : [])),
  ]);
  slices.push([
    "indexable",
    dataset.queries.flatMap((q, i) => {
      const relevant = indexable(corpus, q.relevant);
      return relevant.length > 0 ? [{ ranked: runs[i].ranked, relevant }] : [];
    }),
  ]);
  for (const [slice, cases] of slices) {
    if (cases.length === 0) continue;
    const [r] = rankingMetrics(cases, [maxK]);
    out.push(
      base(`${slice}.recall_at_${maxK}`, `Recall@${maxK} ${slice}`, r.perCase.recall, false),
      base(`${slice}.mrr_at_${maxK}`, `MRR@${maxK} ${slice}`, r.perCase.reciprocalRank, false),
    );
  }
  return out;
}
