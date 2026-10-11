import { assert, assertEquals } from "@std/assert";
import { anchorProblems, anchorsHold, citationSpan, extractCitations, MAX_SPAN_LINES, resolveCitation, strictPathCitation } from "./citations.ts";
import { type IndexedCorpus, loadIndexedCorpus } from "./corpus.ts";
import { SYNTHETIC } from "./corpus-source.ts";

const projectDir = new URL("../", import.meta.url);
let synthetic: Promise<IndexedCorpus> | undefined;
const corpus = () => (synthetic ??= loadIndexedCorpus(projectDir, SYNTHETIC));

const PATHS = ["src/orders/service.ts", "src/db/client.ts", "services/inventory/reserve.go", "workers/email_worker.py"];
const extract = (text: string) => extractCitations(text, PATHS).map(({ raw: _, ...rest }) => rest);

Deno.test("extracts paths with line ranges in every supported form", () => {
  assertEquals(extract("See src/orders/service.ts:21-31 and `src/db/client.ts#L5-L9`."), [
    { path: "src/orders/service.ts", lines: [21, 31] },
    { path: "src/db/client.ts", lines: [5, 9] },
  ]);
  assertEquals(extract("services/inventory/reserve.go (Reserve, lines 31-40)"), [
    { path: "services/inventory/reserve.go", symbol: "Reserve", lines: [31, 40] },
  ]);
  assertEquals(extract("workers/email_worker.py lines 38 to 45"), [{ path: "workers/email_worker.py", lines: [38, 45] }]);
  assertEquals(extract("the services/inventory/ module and reserve.go"), [
    { path: "services/inventory/" },
    { path: "reserve.go" },
  ]);
});

Deno.test("extracts code identifiers but not prose, technologies or URLs", () => {
  assertEquals(extract("createOrder() calls OrderService.listOrders, MAX_ATTEMPTS and send_email."), [
    { symbol: "createOrder" },
    { symbol: "OrderService.listOrders" },
    { symbol: "MAX_ATTEMPTS" },
    { symbol: "send_email" },
  ]);
  assertEquals(extract("Built on Node.js and Next.js for iOS and/or web; see https://example.com/a/b.ts."), []);
  assertEquals(extract("The `withRetry` helper retries."), [{ symbol: "withRetry" }]);
});

Deno.test("strict path citations take the whole value, with an optional range", () => {
  assertEquals(strictPathCitation(" src/orders/service.ts:3-9 ").lines, [3, 9]);
  assertEquals(strictPathCitation("Postgres").path, "Postgres");
});

Deno.test("resolves files, modules, line ranges and symbols against the corpus", async () => {
  const c = await corpus();
  const resolve = (text: string) => resolveCitation(c, extractCitations(text, c.files.keys())[0]);

  const method = resolve("src/orders/service.ts (OrderService.createOrder)");
  assert(method.valid);
  assertEquals(method.symbolLines, [21, 31]);

  // Go methods have no parent in the index; the receiver type must exist in the same file.
  const goMethod = resolve("`Store.Reserve`");
  assertEquals([goMethod.valid, goMethod.file, goMethod.symbolLines], [true, "services/inventory/reserve.go", [31, 40]]);
  assert(!resolve("`Cache.Reserve`").valid);

  const module = resolve("src/payments/");
  assertEquals([module.valid, module.module], [true, true]);
  assertEquals(citationSpan(c, extractCitations("src/payments/", c.files.keys())[0], module), null);

  const badLines = resolve("src/auth/password.ts:10-900");
  assertEquals([badLines.valid, badLines.checks], [false, { path: true, lines: false }]);
  const missing = resolve("src/auth/tokens.ts");
  assertEquals([missing.valid, missing.checks.path], [false, false]);
  const noSymbol = resolve("src/auth/password.ts (bcryptHash)");
  assertEquals([noSymbol.valid, noSymbol.checks], [false, { path: true, symbol: false }]);
});

Deno.test("identifiers in withheld files resolve by whole-word text, with a whole-file span", async () => {
  const c = await corpus();
  assertEquals(c.summary.unindexed["src/config.ts"], "secret");
  const citation = extractCitations("src/config.ts (loadConfig)", c.files.keys())[0];
  const resolution = resolveCitation(c, citation);
  assertEquals([resolution.valid, resolution.symbolLines], [true, undefined]);
  const span = citationSpan(c, citation, resolution)!;
  assertEquals([span.start, span.end, span.truncated], [1, 25, false]);
  assert(!resolveCitation(c, extractCitations("src/config.ts (loadConf)", c.files.keys())[0]).valid);
  assert(MAX_SPAN_LINES >= 100);
});

Deno.test("anchors: presence and absence must both hold; bad anchors are reported", () => {
  const span = "if (!session) {\n  return null;\n}\nreturn session.userId;";
  assert(anchorsHold([{ pattern: "return session\\.userId", present: true }, { pattern: "expiresAt", present: false }], span));
  assert(!anchorsHold([{ pattern: "SESSION", flags: "i", present: false }], span));
  assertEquals(anchorProblems([{ pattern: "(", present: true }]).length, 1);
  assertEquals(anchorProblems([{ pattern: "a", flags: "g", present: true }]).length, 1);
  assertEquals(anchorProblems([{ pattern: "a", present: true }]), []);
});
