import { assert, assertEquals, assertNotEquals } from "@std/assert";
import type { SearchRepositoryOutput } from "@stackprep/shared";
import { createFakeAIProvider, fakeUserOpenAIClients } from "../../../../supabase/functions/_shared/testing.ts";
import type { FakeToolStore } from "../../../../supabase/functions/interviews/testing.ts";
import { createTreeCache } from "../../../../supabase/functions/interviews/tools/get-file.ts";
import { searchRepository } from "../../../../supabase/functions/interviews/tools/search-repository.ts";
import type { ToolContext } from "../../../../supabase/functions/interviews/tools/types.ts";
import { computePins, readPinsFile, verifyPins } from "../../../core/pins.ts";
import {
  CORPUS_WORKSPACE_ID,
  createCorpusGithub,
  createCorpusToolStore,
  type IndexedCorpus,
  loadIndexedCorpus,
} from "./corpus.ts";
import { CORPUS_PINS, loadPinnedCorpus, SNAPSHOT, SYNTHETIC } from "./corpus-source.ts";

const projectDir = new URL("../", import.meta.url);
const cache = new Map<string, Promise<IndexedCorpus>>();
const indexed = (id: string) => {
  if (!cache.has(id)) {
    cache.set(id, loadIndexedCorpus(projectDir, id));
  }
  return cache.get(id)!;
};

function context(corpus: IndexedCorpus, store: FakeToolStore, logs: Record<string, unknown>[] = []): ToolContext {
  return {
    interview: { id: "eval-interview", workspace_id: CORPUS_WORKSPACE_ID, repository_commit_sha: corpus.commitSha },
    userId: "eval-user",
    store,
    github: createCorpusGithub(corpus.files),
    trees: createTreeCache(),
    openai: () => Promise.resolve(fakeUserOpenAIClients({ ai: createFakeAIProvider(() => new Error("retrieval makes no model calls")) })),
    evaluationModel: "none",
    elapsedSeconds: 0,
    requestReport: () => Promise.resolve(),
    log: (entry) => logs.push(entry),
  };
}

async function search(corpus: IndexedCorpus, store: FakeToolStore, query: string, logs?: Record<string, unknown>[]) {
  const outcome = await searchRepository(context(corpus, store, logs), { query, limit: 5 });
  const output = outcome.output as SearchRepositoryOutput;
  assert(output.ok);
  return { results: output.results, evidence: outcome.evidence ?? [] };
}

/** 1-based line of the first line containing `needle`. */
function lineOf(corpus: IndexedCorpus, path: string, needle: string): number {
  const index = corpus.files.get(path)!.split("\n").findIndex((line) => line.includes(needle));
  assert(index !== -1, `${needle} not in ${path}`);
  return index + 1;
}

Deno.test("synthetic corpus indexes every language through the real parser and builds code memory", async () => {
  const corpus = await indexed(SYNTHETIC);
  assertEquals(corpus.commitSha, "5f17e0c0de5f17e0c0de5f17e0c0de5f17e0c0de");
  assertEquals(corpus.summary.statuses.ok + corpus.summary.statuses.skipped, corpus.summary.selected, JSON.stringify(corpus.summary));
  assert(Object.values(corpus.summary.unindexed).every((reason) => reason === "secret"));
  assertEquals([...new Set(corpus.codeFiles.map((f) => f.language))].sort(), ["go", "java", "python", "tsx", "typescript"]);
  assert(!corpus.codeFiles.some((f) => f.path === "README.md" || f.path === "package.json"));
  assert(corpus.summary.memoryRows.code_module > 0 && corpus.summary.memoryRows.file_summary > 0);
  assertEquals(corpus.memory.map((m) => m.kind), [...corpus.memory.map((m) => m.kind)].sort());

  for (const s of corpus.symbols) {
    const lines = corpus.files.get(s.path)!.split("\n").length;
    assert(s.start_line >= 1 && s.start_line <= s.end_line && s.end_line <= lines, `${s.path} ${s.name}`);
  }
  const charge = corpus.symbols.find((s) => s.name === "chargeCard")!;
  assertEquals([charge.path, charge.start_line], ["src/payments/charge.ts", lineOf(corpus, "src/payments/charge.ts", "export function chargeCard")]);
  const reserve = corpus.symbols.find((s) => s.name === "Reserve")!;
  assertEquals([reserve.path, reserve.start_line], ["services/inventory/reserve.go", lineOf(corpus, "services/inventory/reserve.go", "func (s *Store) Reserve")]);
  assert(corpus.symbols.some((s) => s.name === "process" && s.parent_name === "EmailWorker"));
  assert(corpus.symbols.some((s) => s.name === "exportAll" && s.parent_name === "ReportExporter"));
  assert(corpus.fileSymbols["web/components/CartSummary.tsx"].some((s) => s.name === "computeTotals"));
});

Deno.test("indexing is deterministic", async () => {
  const strip = ({ files: _files, ...rest }: IndexedCorpus) => JSON.stringify(rest);
  const again = await loadIndexedCorpus(projectDir, SYNTHETIC);
  assertEquals(strip(again), strip(await indexed(SYNTHETIC)));
});

Deno.test("the real searchRepository returns symbol and keyword hits from the indexed synthetic corpus", async () => {
  const corpus = await indexed(SYNTHETIC);
  const logs: Record<string, unknown>[] = [];
  const bySymbol = await search(corpus, createCorpusToolStore(corpus), "chargeCard", logs);
  const symbolHit = bySymbol.results.find((r) => r.symbol === "chargeCard");
  assertEquals(symbolHit?.path, "src/payments/charge.ts");
  assertEquals(symbolHit?.startLine, lineOf(corpus, "src/payments/charge.ts", "export function chargeCard"));
  assert(bySymbol.evidence.some((e) => e.path === "src/payments/charge.ts" && e.commit_sha === corpus.commitSha));
  assert(logs.some((l) => l.event === "repository_search_vector_fallback" && l.reason === "disabled"));

  const byKeyword = await search(corpus, createCorpusToolStore(corpus), "rate limit middleware");
  assert(byKeyword.results.some((r) => r.path === "src/middleware/rate-limit.ts"), JSON.stringify(byKeyword.results));
});

Deno.test("removing the symbol rows removes symbol hits", async () => {
  const corpus = await indexed(SYNTHETIC);
  const withSymbols = await search(corpus, createCorpusToolStore(corpus), "withRetry");
  const without = await search(corpus, createCorpusToolStore(corpus, { symbols: [] }), "withRetry");
  assert(withSymbols.results.some((r) => r.symbol === "withRetry"));
  assert(!without.results.some((r) => r.symbol));
});

// Characterizes production behaviour the datasets depend on. scrubSecrets' key/value rule matches
// ordinary code such as `password: string` or `token: randomBytes(32)`, and runCodeIndex then withholds
// the whole file. If production changes, update this test and re-label the affected queries.
Deno.test("files the production secret check withholds are invisible to the index", async () => {
  const synthetic = await indexed(SYNTHETIC);
  assertEquals(synthetic.summary.unindexed, { "src/auth/password.ts": "secret", "src/auth/session.ts": "secret", "src/config.ts": "secret" });
  assert(!synthetic.memory.some((m) => m.structured.path === "src/auth/session.ts"));
  const { results } = await search(synthetic, createCorpusToolStore(synthetic), "verifySession");
  assert(!results.some((r) => r.symbol), JSON.stringify(results));

  const snapshot = await indexed(SNAPSHOT);
  assertEquals(snapshot.summary.unindexed["supabase/functions/interviews/tools/search-repository.ts"], "secret");
  assertEquals(snapshot.summary.unindexed["supabase/functions/interviews/tools/evaluate-answer.ts"], "secret");
});

Deno.test("the StackPrep snapshot is pinned to its commit and searchable", async () => {
  const source = await loadPinnedCorpus(projectDir, SNAPSHOT);
  const corpus = await indexed(SNAPSHOT);
  assertEquals(corpus.commitSha, source.manifest.commit_sha);
  assert(![...corpus.files.keys()].some((p) => p.startsWith("evals/") || p.endsWith(".test.ts")));
  assertEquals(corpus.summary.statuses.failed + corpus.summary.statuses.unsupported, 0, JSON.stringify(corpus.summary));
  assert(corpus.summary.statuses.ok + corpus.summary.statuses.partial > 50, JSON.stringify(corpus.summary));

  const path = "supabase/functions/_shared/code-index/select.ts";
  const { results } = await search(corpus, createCorpusToolStore(corpus), "selectCodeFiles");
  const hit = results.find((r) => r.symbol === "selectCodeFiles");
  assertEquals(hit?.path, path);
  assertEquals(hit?.startLine, lineOf(corpus, path, "export function selectCodeFiles"));
});

Deno.test("the corpus GitHub fake serves each long path its own content", async () => {
  const corpus = await indexed(SNAPSHOT);
  const github = createCorpusGithub(corpus.files);
  const { entries } = await github.getRepositoryTree(1, "eval", corpus.id, corpus.commitSha);
  const pick = (path: string) => entries.find((e) => e.path === path)!;
  const a = pick("supabase/functions/interviews/tools/search-repository.ts");
  const b = pick("supabase/functions/interviews/tools/evaluate-answer.ts");
  assertNotEquals(a.sha, b.sha);
  const text = async (sha: string) => new TextDecoder().decode((await github.getBlob(1, "eval", corpus.id, sha, 1 << 20))!);
  assertEquals(await text(a.sha), corpus.files.get(a.path));
  assertEquals(await text(b.sha), corpus.files.get(b.path));
});

Deno.test("corpus files match pins.json", async () => {
  const verification = verifyPins(await computePins(projectDir, CORPUS_PINS), await readPinsFile(new URL("pins.json", projectDir)));
  assert(verification.ok, JSON.stringify(verification.checks));
});
