import { assert, assertEquals } from "@std/assert";
import { createFakeEmbeddingProvider, fakeEmbedding } from "../../../../supabase/functions/_shared/testing.ts";
import { type IndexedCorpus, loadIndexedCorpus } from "./corpus.ts";
import { SYNTHETIC } from "./corpus-source.ts";
import { embedCorpus, embeddableRows, matchVectors, resultId, runSearch } from "./search.ts";

const projectDir = new URL("../", import.meta.url);
let synthetic: Promise<IndexedCorpus> | undefined;
const corpus = () => (synthetic ??= loadIndexedCorpus(projectDir, SYNTHETIC));

Deno.test("matchVectors ranks by cosine similarity, breaks ties by kind, and clamps the count like the SQL", () => {
  const rows = [
    { kind: "file_summary", content: "b", vector: [1, 0] },
    { kind: "code_module", content: "a", vector: [1, 0] },
    { kind: "file_summary", content: "c", vector: [0, 1] },
  ];
  const matches = matchVectors(rows, [2, 0], 10);
  assertEquals(matches.map((m) => m.content), ["a", "b", "c"]);
  assertEquals(matches[0].similarity, 1);
  assertEquals(matches[2].similarity, 0);
  assertEquals(matchVectors(rows, [1, 0], 0).length, 1);
  const many = Array.from({ length: 60 }, (_, i) => ({ kind: "file_summary", content: String(i), vector: [1, i] }));
  assertEquals(matchVectors(many, [1, 0], 100).length, 50);
});

Deno.test("resultId keeps paths and credits row-level hits to the path their excerpt names", () => {
  assertEquals(resultId({ path: "src/a.ts", excerpt: "x" }), "src/a.ts");
  assertEquals(resultId({ path: ".", area: "file_summary", excerpt: "src/a.ts (typescript, 12 lines)\nSymbols: f" }), "src/a.ts");
  assertEquals(resultId({ path: ".", area: "code_module", excerpt: "Module src/orders/ (typescript; 2 indexed files: a.ts)" }), "src/orders/");
  assertEquals(resultId({ path: ".", area: "architecture_summary", excerpt: "src/a.ts (typescript, 12 lines)" }), ".");
  assertEquals(resultId({ path: ".", area: "file_summary", excerpt: "no path here" }), ".");
});

Deno.test("corpus rows are embedded with the production embedding input", async () => {
  const rows = embeddableRows(await corpus());
  assert(rows.length > 0);
  for (const row of rows) assertEquals(row.input, `${row.kind}\n${row.content}`);
});

Deno.test("keyword config drops symbol hits; symbol config returns them", async () => {
  const c = await corpus();
  const keyword = await runSearch(c, "keyword", "withRetry", { limit: 5 });
  const symbol = await runSearch(c, "symbol", "withRetry", { limit: 5 });
  assert(!keyword.results.some((r) => r.symbol));
  assert(symbol.results.some((r) => r.symbol === "withRetry" && r.path === "src/utils/retry.ts"));
  assertEquals(keyword.fallback, "disabled");
});

Deno.test("hybrid fills free slots through the real vector fill and credits the matched row's file", async () => {
  const c = await corpus();
  const target = embeddableRows(c).find((r) => r.kind === "file_summary" && r.content.startsWith("web/components/CartSummary.tsx"))!;
  // A query no keyword or symbol matches, embedded exactly like the CartSummary row.
  const query = "zzqx vvkj";
  const provider = createFakeEmbeddingProvider((r) => r.input.map((t) => fakeEmbedding(t === query ? target.input : t)));
  const vectors = await embedCorpus(c, provider, "embed-test");
  const run = await runSearch(c, "hybrid", query, { limit: 5, vectors, queryEmbeddings: { provider, model: "embed-test" } });
  assert(run.vectorFilled);
  assertEquals(run.fallback, undefined);
  // Characterizes production: the fill de-duplicates by path and area, and every vector hit is path "."
  // with its kind as area, so at most one hit per memory kind survives however many slots are free.
  assertEquals(run.results.map((r) => r.area), ["file_summary", "code_module"]);
  assertEquals(run.ranked[0], "web/components/CartSummary.tsx");
  assert(run.results.every((r) => r.path === "."), "vector hits are row-level in production");
  assert(!run.ranked.includes("."), JSON.stringify(run.ranked));
});

Deno.test("hybrid leaves full keyword and symbol results untouched", async () => {
  const c = await corpus();
  const provider = createFakeEmbeddingProvider();
  const vectors = await embedCorpus(c, provider, "embed-test");
  const symbol = await runSearch(c, "symbol", "order service create orders", { limit: 5 });
  const hybrid = await runSearch(c, "hybrid", "order service create orders", { limit: 5, vectors, queryEmbeddings: { provider, model: "embed-test" } });
  assertEquals(symbol.ranked.length, 5);
  assertEquals(hybrid.ranked, symbol.ranked);
  assert(!hybrid.vectorFilled);
});
