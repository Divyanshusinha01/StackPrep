import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { EmbeddingProvider } from "../../../../supabase/functions/_shared/ai/provider.ts";
import { createFakeEmbeddingProvider } from "../../../../supabase/functions/_shared/testing.ts";
import { createFileRecorder } from "../../../core/recording.ts";
import type { EvalMode, Metric, Recorder, RunEnv, SuiteResult } from "../../../core/types.ts";
import { CONFIG } from "../project.ts";
import { recordedEmbeddingProvider } from "../src/ai.ts";
import { type IndexedCorpus, loadIndexedCorpus } from "../src/corpus.ts";
import { SNAPSHOT, SYNTHETIC } from "../src/corpus-source.ts";
import { embedCorpus } from "../src/search.ts";
import {
  loadRetrievalDataset,
  QUERY_TYPES,
  type RetrievalContext,
  type RetrievalDataset,
  retrievalSuite,
  validateDataset,
} from "./retrieval.ts";

const projectDir = new URL("../", import.meta.url);
const cache = new Map<string, Promise<IndexedCorpus>>();
const indexed = (id: string) => {
  if (!cache.has(id)) cache.set(id, loadIndexedCorpus(projectDir, id));
  return cache.get(id)!;
};

const passThrough: Recorder = { call: (_req, produce) => produce() };

function env(recorder: Recorder, mode: EvalMode = "replay"): RunEnv {
  return { mode, recorder, seed: 1, samples: 1, log: () => {} };
}

function context(corpus: IndexedCorpus, recorder: Recorder, live?: EmbeddingProvider): RetrievalContext {
  const rows = recordedEmbeddingProvider(recorder, {
    provider: live,
    site: "embedding.corpus",
    dimensions: CONFIG.embedding.dimensions,
    decimals: CONFIG.embedding.decimals,
  });
  return {
    projectDir,
    corpora: new Map([[corpus.id, corpus]]),
    retrieval: { ...CONFIG.retrieval, embedding: CONFIG.embedding },
    liveEmbedding: live,
    corpusVectors: () => embedCorpus(corpus, rows, CONFIG.embedding.model),
  };
}

const byId = (result: SuiteResult) => new Map(result.metrics.map((m) => [m.id, m]));
const value = (result: SuiteResult, id: string) => byId(result).get(id)!.value;

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "evals-retrieval-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("both retrieval datasets are valid, labelled and balanced across query types", async () => {
  for (const id of [SYNTHETIC, SNAPSHOT]) {
    const corpus = await indexed(id);
    const dataset = await loadRetrievalDataset(projectDir, corpus);
    assert(dataset.queries.length >= 40, `${id}: ${dataset.queries.length} queries`);
    for (const type of QUERY_TYPES) {
      assert(dataset.queries.filter((q) => q.type === type).length >= 10, `${id}: too few ${type} queries`);
    }
  }
});

Deno.test("validateDataset rejects unknown paths, duplicates, unlabelled and oversized queries", async () => {
  const corpus = await indexed(SYNTHETIC);
  const dataset: RetrievalDataset = {
    format: 1,
    corpus: SYNTHETIC,
    guidelines: [],
    queries: [
      { id: "a", type: "exact", query: "chargeCard", relevant: ["src/payments/charge.ts", "src/orders/"] },
      { id: "a", type: "exact", query: "x", relevant: ["src/nope.ts"] },
      { id: "b", type: "exact", query: "x", relevant: [] },
      { id: "c", type: "exact", query: "x".repeat(201), relevant: ["src/server.ts"] },
    ],
  };
  const problems = validateDataset(dataset, corpus);
  assertEquals(problems.length, 4, problems.join("\n"));
  assertStringIncludes(problems.join("\n"), "src/nope.ts");
  assertEquals(validateDataset({ ...dataset, corpus: SNAPSHOT, queries: [dataset.queries[0]] }, corpus).length, 1);
});

Deno.test("the suite emits every configuration's metrics, gating only the overall top-k on a gated corpus", async () => {
  const corpus = await indexed(SYNTHETIC);
  const live = createFakeEmbeddingProvider();
  const result = await retrievalSuite(SYNTHETIC, { gate: true }).run(context(corpus, passThrough, live), env(passThrough, "live"));
  const ids = result.metrics.map((m) => m.id);
  assertEquals(new Set(ids).size, ids.length);
  for (const config of ["keyword", "symbol", "hybrid"]) {
    for (const k of [1, 3, 5]) {
      for (const m of ["precision", "recall", "mrr"]) assert(ids.includes(`retrieval.synthetic.${config}.${m}_at_${k}`));
    }
    for (const slice of [...QUERY_TYPES, "indexable"]) assert(ids.includes(`retrieval.synthetic.${config}.${slice}.recall_at_5`));
  }
  assertEquals(result.metrics.filter((m) => m.gate).map((m) => m.id).sort(), [
    "retrieval.synthetic.hybrid.mrr_at_5",
    "retrieval.synthetic.hybrid.precision_at_5",
    "retrieval.synthetic.hybrid.recall_at_5",
    "retrieval.synthetic.keyword.mrr_at_5",
    "retrieval.synthetic.keyword.precision_at_5",
    "retrieval.synthetic.keyword.recall_at_5",
    "retrieval.synthetic.symbol.mrr_at_5",
    "retrieval.synthetic.symbol.precision_at_5",
    "retrieval.synthetic.symbol.recall_at_5",
  ]);
  for (const m of result.metrics as Metric[]) {
    assertEquals([m.corpus, m.provenance, m.direction], ["synthetic", "deterministic", "higher_is_better"]);
    assert(m.ci && m.ci[0] <= m.value + 1e-9 && m.value <= m.ci[1] + 1e-9, m.id);
  }
  assertEquals(result.cases?.length, 46);
  assert(result.caveats?.some((c) => c.includes("vector fill runs only when")));

  const ungated = await retrievalSuite(SYNTHETIC, { gate: false }).run(context(corpus, passThrough, live), env(passThrough, "live"));
  assert(ungated.metrics.every((m) => !m.gate));
});

Deno.test("removing the symbol rows brings +symbol down to keyword-only (deliberate break)", async () => {
  const corpus = await indexed(SYNTHETIC);
  const suite = retrievalSuite(SYNTHETIC, { gate: true });
  const live = createFakeEmbeddingProvider();
  const intact = await suite.run(context(corpus, passThrough, live), env(passThrough, "live"));
  const broken = await suite.run(context({ ...corpus, symbols: [] }, passThrough, live), env(passThrough, "live"));
  const id = "retrieval.synthetic.symbol.recall_at_5";
  assert(value(intact, id) > value(intact, "retrieval.synthetic.keyword.recall_at_5"));
  assert(value(broken, id) < value(intact, id));
  assertEquals(value(broken, id), value(broken, "retrieval.synthetic.keyword.recall_at_5"));
});

Deno.test("without recorded embeddings, replay reports keyword and +symbol, omits hybrid and records the misses", async () => {
  const corpus = await indexed(SYNTHETIC);
  await withDir(async (dir) => {
    const recorder = createFileRecorder({ dir, mode: "replay", pins: {} });
    const result = await retrievalSuite(SYNTHETIC, { gate: true }).run(context(corpus, recorder), env(recorder));
    assert(result.metrics.some((m) => m.id.startsWith("retrieval.synthetic.symbol.")));
    assert(!result.metrics.some((m) => m.id.startsWith("retrieval.synthetic.hybrid.")));
    assert(result.caveats?.some((c) => c.startsWith("hybrid not measured")));
    assert(recorder.stats().misses.some((m) => m.site === "embedding.corpus"));
  });
});

Deno.test("recorded embeddings replay to identical hybrid metrics with no provider", async () => {
  const corpus = await indexed(SYNTHETIC);
  await withDir(async (dir) => {
    const suite = retrievalSuite(SYNTHETIC, { gate: true });
    const record = createFileRecorder({ dir, mode: "record", pins: {} });
    const recorded = await suite.run(context(corpus, record, createFakeEmbeddingProvider()), env(record, "record"));
    assert(recorded.metrics.some((m) => m.id === "retrieval.synthetic.hybrid.recall_at_5"));

    const replay = createFileRecorder({ dir, mode: "replay", pins: {} });
    const replayed = await suite.run(context(corpus, replay), env(replay));
    assertEquals(replay.stats().misses, []);
    assertEquals(JSON.stringify(replayed), JSON.stringify(recorded));
  });
});
