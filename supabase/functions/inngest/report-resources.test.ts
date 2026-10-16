import { assert, assertEquals, assertRejects } from "@std/assert";
import type { QuestionReview } from "@stackprep/shared";
import { AIQuotaError, AIUnavailableError, type WebCitation } from "../_shared/ai/provider.ts";
import { createFakeAIProvider, createFakeWebSearchProvider } from "../_shared/testing.ts";
import {
  candidatesFrom,
  findConceptResources,
  normalizeResourceUrl,
  type QueryGuard,
  type ResourceDeps,
  sourceRank,
  vetSearchQuery,
} from "./report-resources.ts";

const guard: QueryGuard = {
  repositoryFullName: "alice/payments-api",
  paths: ["src/billing/ledger.ts", "supabase/migrations/001_init.sql"],
  symbols: ["reconcileLedger", "id"],
};

Deno.test("search queries must be generic technical terms", () => {
  assertEquals(vetSearchQuery({ query: "postgres transaction isolation", name: "Isolation" }, guard), "postgres transaction isolation");
  assertEquals(vetSearchQuery({ query: "  idempotent   http  requests ", name: "x" }, guard), "idempotent http requests");
  assertEquals(vetSearchQuery({ query: "C++ move semantics", name: "x" }, guard), "C++ move semantics");

  const rejected = [
    "alice/payments-api retries",
    "payments-api ledger",
    "how ledger.ts works",
    "reconcileLedger function",
    "rotate sk-proj-abcdefghijklmnopqrstuvwxyz012345",
    "token=abcdef123456 usage",
    "<script>alert(1)</script>",
    "ab",
    "x".repeat(81),
  ];
  for (const query of rejected) {
    assertEquals(vetSearchQuery({ query, name: "payments-api internals" }, guard), null, query);
  }
});

Deno.test("a rejected query falls back to a clean concept name", () => {
  assertEquals(vetSearchQuery({ query: "ledger.ts double entry", name: "Double-entry bookkeeping" }, guard), "Double-entry bookkeeping");
});

Deno.test("short symbols do not block common words", () => {
  assertEquals(vetSearchQuery({ query: "database id generation", name: "x" }, guard), "database id generation");
});

Deno.test("resource URLs must be public https without credentials, custom ports, or tracking", () => {
  assertEquals(
    normalizeResourceUrl("https://developer.mozilla.org/en-US/docs/Web?utm_source=openai&utm_medium=x&lang=en#top"),
    "https://developer.mozilla.org/en-US/docs/Web?lang=en",
  );
  assertEquals(normalizeResourceUrl("https://example.org:443/a?fbclid=1"), "https://example.org/a");
  const rejected = [
    "http://developer.mozilla.org/",
    "javascript:alert(1)",
    "data:text/html,hi",
    "ftp://example.org/file",
    "https://user:pass@example.org/",
    "https://example.org:8443/",
    "https://localhost/",
    "https://127.0.0.1/",
    "https://10.0.0.5/admin",
    "https://[::1]/",
    "https://metadata.internal/",
    "https://intranet/",
    "not a url",
  ];
  for (const url of rejected) {
    assertEquals(normalizeResourceUrl(url), null, url);
  }
});

Deno.test("official documentation ranks first and duplicates collapse", () => {
  assertEquals(sourceRank("https://www.postgresql.org/docs/current/mvcc.html"), 0);
  assertEquals(sourceRank("https://docs.example.com/guide"), 1);
  assertEquals(sourceRank("https://someblog.example.net/post"), 2);
  const citations: WebCitation[] = [
    { url: "https://someblog.example.net/post", title: "Blog", excerpt: "A blog." },
    { url: "https://www.postgresql.org/docs/current/mvcc.html?utm_source=openai", title: "MVCC", excerpt: "Docs." },
    { url: "https://www.postgresql.org/docs/current/mvcc.html", title: "MVCC again", excerpt: "Dup." },
    { url: "http://insecure.example.net/", title: "Insecure", excerpt: "No." },
  ];
  assertEquals(candidatesFrom(citations).map((c) => [c.publisher, c.title]), [
    ["postgresql.org", "MVCC"],
    ["someblog.example.net", "Blog"],
  ]);
});

const REVIEW = {
  concept_ids: ["mvcc"],
  factual_errors: ["Said readers block writers."],
  missing_concepts: ["Snapshot isolation"],
} as unknown as QuestionReview;

function deps(search: () => WebCitation[] | Error, notes: () => unknown = () => new AIUnavailableError(503)) {
  const logs: Record<string, unknown>[] = [];
  const searchProvider = createFakeWebSearchProvider(search);
  const ai = createFakeAIProvider(notes);
  const d: ResourceDeps = { search: searchProvider, ai, searchModel: "s", notesModel: "n", log: (e) => logs.push(e) };
  return { d, searchProvider, ai, logs };
}

const MVCC = { concept_id: "mvcc", name: "MVCC", query: "postgres mvcc" };

Deno.test("without notes, the search model's sentence stands in and the concept name is the gap", async () => {
  const { d } = deps(() => [{ url: "https://www.postgresql.org/docs/current/mvcc.html", title: "MVCC", excerpt: "Explains snapshots." }]);
  const { resources } = await findConceptResources(d, [MVCC], [REVIEW], guard);
  assertEquals(resources.mvcc, {
    status: "ok",
    resources: [{
      title: "MVCC",
      publisher: "postgresql.org",
      url: "https://www.postgresql.org/docs/current/mvcc.html",
      what_to_learn: "Explains snapshots.",
      addresses: "MVCC",
    }],
  });
});

Deno.test("sources marked irrelevant by the notes call are dropped", async () => {
  const { d, ai } = deps(
    () => [{ url: "https://www.postgresql.org/docs/current/mvcc.html", title: "MVCC", excerpt: "Explains snapshots." }],
    () => ({ notes: [{ source_id: "c1s1", relevant: false, what_to_learn: "x", addresses: "y" }] }),
  );
  const { resources, usage } = await findConceptResources(d, [MVCC], [REVIEW], guard);
  assertEquals(resources.mvcc, { status: "unavailable", reason: "no_valid_sources", resources: [] });
  assertEquals(usage.map((u) => u.model), ["s", "n"]);
  assert(ai.calls[0].input.includes("Said readers block writers."), "gaps from linked reviews reach the notes call");
  assert(ai.calls[0].input.includes("<concepts>"));
});

Deno.test("search failures degrade per concept; key failures propagate", async () => {
  const failed = deps(() => new AIUnavailableError(503));
  const { resources } = await findConceptResources(failed.d, [MVCC], [], guard);
  assertEquals(resources.mvcc, { status: "unavailable", reason: "search_failed", resources: [] });
  assertEquals(failed.logs, [{ event: "report_resource_search_failed", reason: "AIUnavailableError" }]);

  const quota = deps(() => new AIQuotaError());
  await assertRejects(() => findConceptResources(quota.d, [MVCC], [], guard), AIQuotaError);
});

Deno.test("rejected queries never reach the search provider", async () => {
  const { d, searchProvider } = deps(() => []);
  const { resources } = await findConceptResources(
    d,
    [{ concept_id: "ledger", name: "payments-api ledger", query: "alice/payments-api ledger" }],
    [],
    guard,
  );
  assertEquals(searchProvider.calls.length, 0);
  assertEquals(resources.ledger, { status: "unavailable", reason: "query_rejected", resources: [] });
});

Deno.test("at most three resources are kept per concept and none are invented", async () => {
  const citations = Array.from({ length: 6 }, (_, i) => ({
    url: `https://docs.example${i}.com/page`,
    title: `Doc ${i}`,
    excerpt: `Teaches part ${i}.`,
  }));
  const { d } = deps(() => citations);
  const { resources } = await findConceptResources(d, [MVCC], [], guard);
  assertEquals(resources.mvcc.resources.length, 3);
  const allowed = new Set(citations.map((c) => c.url));
  assert(resources.mvcc.resources.every((r) => allowed.has(r.url)));
});
