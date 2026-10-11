/**
 * The three retrieval configurations, all through the production `searchRepository` (keyword ranking,
 * `mergeSymbolHits`, the vector fill and its fallbacks):
 * - keyword: memory rows only; no symbol rows, no embeddings.
 * - symbol: memory rows plus the code index symbols.
 * - hybrid: symbols plus embeddings; the query is embedded by the given provider and matched by cosine
 *   against embedded memory rows, standing in for `match_repository_memory`.
 *
 * Offline limits: symbol ranking is the fake store's in-memory ranking, not the `search_code_symbols` SQL,
 * and the cosine match is exact, not the pgvector HNSW index.
 */
import type { SearchRepositoryOutput } from "@stackprep/shared";
import type { EmbeddingProvider } from "../../../../supabase/functions/_shared/ai/provider.ts";
import { createFakeAIProvider } from "../../../../supabase/functions/_shared/testing.ts";
import { buildEmbeddingInput } from "../../../../supabase/functions/inngest/memory-embedding.ts";
import type { FakeToolStore } from "../../../../supabase/functions/interviews/testing.ts";
import { createTreeCache } from "../../../../supabase/functions/interviews/tools/get-file.ts";
import { searchRepository } from "../../../../supabase/functions/interviews/tools/search-repository.ts";
import type { MemoryMatch, ToolContext } from "../../../../supabase/functions/interviews/tools/types.ts";
import { CORPUS_WORKSPACE_ID, createCorpusGithub, createCorpusToolStore, type IndexedCorpus } from "./corpus.ts";

export const RETRIEVAL_CONFIGS = ["keyword", "symbol", "hybrid"] as const;
export type RetrievalConfig = typeof RETRIEVAL_CONFIGS[number];

export const CONFIG_LABELS: Record<RetrievalConfig, string> = { keyword: "keyword", symbol: "+symbol", hybrid: "hybrid" };

/** `match_repository_memory` clamps the requested count to this range. */
const MATCH_COUNT_MIN = 1;
const MATCH_COUNT_MAX = 50;
/** Replay is local; a generous budget keeps the vector fill from timing out on a slow machine or a live call. */
const EVAL_VECTOR_BUDGET_MS = 60_000;
/** Corpus rows embedded at once when recording, to stay polite to the provider's rate limits. */
const EMBED_CONCURRENCY = 8;
/** Kinds whose row-level excerpt starts with the path it describes (see `fileSummaryRow`, `codeModuleRow`). */
const ATTRIBUTED_KINDS = new Map<string, RegExp>([
  ["file_summary", /^(\S+) \(/],
  ["code_module", /^Module (\S+) \(/],
]);

/** An embedded memory row: what `match_repository_memory` would rank. */
export interface MemoryVector {
  kind: string;
  content: string;
  vector: number[];
}

/** A ToolContext over an indexed corpus. Model calls are refused: retrieval makes none. */
export function corpusToolContext(
  corpus: IndexedCorpus,
  store: FakeToolStore,
  options: { embeddings?: ToolContext["embeddings"]; log?: ToolContext["log"] } = {},
): ToolContext {
  return {
    interview: { id: "eval-interview", workspace_id: CORPUS_WORKSPACE_ID, repository_commit_sha: corpus.commitSha },
    userId: "eval-user",
    store,
    github: createCorpusGithub(corpus.files),
    trees: createTreeCache(),
    ai: createFakeAIProvider(() => new Error("retrieval makes no model calls")),
    evaluationModel: "none",
    elapsedSeconds: 0,
    requestReport: () => Promise.resolve(),
    log: options.log ?? (() => {}),
    ...(options.embeddings ? { embeddings: options.embeddings } : {}),
  };
}

/** The memory rows production embeds (non-empty content), with the exact text `runMemoryEmbedding` sends. */
export function embeddableRows(corpus: IndexedCorpus): { kind: string; content: string; input: string }[] {
  return corpus.memory
    .filter((row) => row.content.trim().length > 0)
    .map((row) => ({ kind: row.kind, content: row.content, input: buildEmbeddingInput(row) }));
}

/**
 * Embeds every embeddable row, one request per row so a changed row re-records only itself. Every row is
 * attempted even after a failure, so a replay run reports all missing recordings at once.
 */
export async function embedCorpus(corpus: IndexedCorpus, provider: EmbeddingProvider, model: string): Promise<MemoryVector[]> {
  const rows = embeddableRows(corpus);
  const settled: PromiseSettledResult<{ embeddings: number[][] }>[] = [];
  for (let start = 0; start < rows.length; start += EMBED_CONCURRENCY) {
    const chunk = rows.slice(start, start + EMBED_CONCURRENCY);
    settled.push(...await Promise.allSettled(chunk.map((row) => provider.embed({ model, input: [row.input] }))));
  }
  const failed = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
  if (failed) {
    throw failed.reason;
  }
  return rows.map((row, i) => ({
    kind: row.kind,
    content: row.content,
    vector: (settled[i] as PromiseFulfilledResult<{ embeddings: number[][] }>).value.embeddings[0],
  }));
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new RangeError(`cosine: length ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** Nearest rows first, like `match_repository_memory` (1 - cosine distance, count clamped to 1..50). */
export function matchVectors(rows: readonly MemoryVector[], query: readonly number[], limit: number): MemoryMatch[] {
  const count = Math.min(Math.max(limit, MATCH_COUNT_MIN), MATCH_COUNT_MAX);
  return rows
    .map((row) => ({ kind: row.kind, content: row.content, similarity: cosine(row.vector, query) }))
    .sort((a, b) =>
      b.similarity - a.similarity || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) ||
      (a.content < b.content ? -1 : a.content > b.content ? 1 : 0)
    )
    .slice(0, count);
}

type SearchResult = SearchRepositoryOutput["results"][number];

/**
 * The id a result is scored under: its path, or for a row-level hit (path "."), the file or module its
 * excerpt names on the first line. Production returns vector-fill hits as row-level hits and records no
 * evidence for them; attributing them is what lets the hybrid configuration be measured at all.
 */
export function resultId(result: SearchResult): string {
  if (result.path !== ".") {
    return result.path;
  }
  const pattern = result.area ? ATTRIBUTED_KINDS.get(result.area) : undefined;
  return (pattern && result.excerpt.split("\n", 1)[0].match(pattern)?.[1]) || ".";
}

export interface SearchRun {
  /** Scored ids in returned order. */
  ranked: string[];
  results: SearchResult[];
  /** True when the vector fill matched rows (keyword and symbol hits left free slots). */
  vectorFilled: boolean;
  /** Reason logged when the vector fill did not run or failed; "disabled" without embeddings. */
  fallback?: string;
}

export interface SearchOptions {
  limit: number;
  /** Required for hybrid: the embedded corpus rows and the provider that embeds queries. */
  vectors?: readonly MemoryVector[];
  queryEmbeddings?: { provider: EmbeddingProvider; model: string };
}

/** Runs one query through the real `searchRepository` in the given configuration, on a fresh store. */
export async function runSearch(corpus: IndexedCorpus, config: RetrievalConfig, query: string, options: SearchOptions): Promise<SearchRun> {
  const store = createCorpusToolStore(corpus, config === "keyword" ? { symbols: [] } : {});
  let embeddings: ToolContext["embeddings"];
  if (config === "hybrid") {
    const { vectors, queryEmbeddings } = options;
    if (!vectors || !queryEmbeddings) {
      throw new Error("hybrid search needs corpus vectors and a query embedding provider");
    }
    store.matchRepositoryMemory = (_workspaceId, _commitSha, embedding, limit) => {
      store.matchCalls.push({ embedding, limit });
      return Promise.resolve(matchVectors(vectors, embedding, limit));
    };
    embeddings = { ...queryEmbeddings, budgetMs: EVAL_VECTOR_BUDGET_MS };
  }
  const logs: Record<string, unknown>[] = [];
  const outcome = await searchRepository(
    corpusToolContext(corpus, store, { embeddings, log: (entry) => logs.push(entry) }),
    { query, limit: options.limit },
  );
  const output = outcome.output as SearchRepositoryOutput;
  if (!output.ok) {
    throw new Error(`searchRepository failed for "${query}": ${JSON.stringify(output)}`);
  }
  const fallback = logs.find((l) => l.event === "repository_search_vector_fallback")?.reason;
  return {
    ranked: output.results.map(resultId),
    results: output.results,
    vectorFilled: store.matchCalls.length > 0 && fallback === undefined,
    ...(typeof fallback === "string" ? { fallback } : {}),
  };
}
