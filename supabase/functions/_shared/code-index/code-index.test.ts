import { assert, assertEquals } from "@std/assert";
import type { CodeFacts } from "@stackprep/code-parser";
import { batchEdgePayloads, type CodeLinkFile, EDGE_BATCH_FILES, EDGE_BATCH_ROWS, linkFiles } from "./link.ts";
import type { CodeFilePayload, FileOutline } from "./mapper.ts";
import { hydratePayload, resolveRelativeImport, toFilePayload, toOutline } from "./mapper.ts";
import { buildCodeMemory, CODE_MEMORY_LIMITS, NON_SUMMARY_KIND_LIST, NON_SUMMARY_KINDS } from "./memory.ts";
import { type FileSymbol, pickFileSymbol } from "./reader.ts";
import { type CodeIndexFile, DEFAULT_CODE_INDEX_LIMITS, planBatches, selectCodeFiles } from "./select.ts";

const known = new Set(["src/a.ts", "src/lib/b.ts", "src/lib/index.ts", "src/c.tsx", "pkg/mod.py", "pkg/sub/__init__.py"]);

Deno.test("relative imports resolve by path only", () => {
  assertEquals(resolveRelativeImport("src/a.ts", "typescript", "./lib/b", known), "src/lib/b.ts");
  assertEquals(resolveRelativeImport("src/a.ts", "typescript", "./lib/b.js", known), "src/lib/b.ts", "a .js specifier finds the .ts file");
  assertEquals(resolveRelativeImport("src/a.ts", "typescript", "./lib", known), "src/lib/index.ts");
  assertEquals(resolveRelativeImport("src/lib/b.ts", "typescript", "../c", known), "src/c.tsx");
  assertEquals(resolveRelativeImport("src/a.ts", "typescript", "react", known), null, "packages never resolve");
  assertEquals(resolveRelativeImport("src/a.ts", "typescript", "../../x", known), null, "nothing above the root");
  assertEquals(resolveRelativeImport("pkg/x.py", "python", ".mod", known), "pkg/mod.py");
  assertEquals(resolveRelativeImport("pkg/x.py", "python", ".sub", known), "pkg/sub/__init__.py");
  assertEquals(resolveRelativeImport("pkg/x.py", "python", "os", known), null);
  assertEquals(resolveRelativeImport("pkg/x.py", "python", "pkg.mod", known), "pkg/mod.py", "absolute modules found in the repository resolve");
  assertEquals(resolveRelativeImport("src/a.ts", "kotlin", "./lib/b", known), null, "unsupported languages never resolve");
});

Deno.test("C includes and Go packages resolve through the shared resolver", () => {
  const paths = new Set(["src/util.h", "src/util.c", "src/main.c", "internal/store/db.go", "cmd/app/main.go"]);
  assertEquals(resolveRelativeImport("src/main.c", "c", "util.h", paths), "src/util.h");
  assertEquals(resolveRelativeImport("src/main.c", "c", "<stdio.h>", paths), null, "system headers are external");
  assertEquals(resolveRelativeImport("cmd/app/main.go", "go", "github.com/acme/app/internal/store", paths), "internal/store/");
});

Deno.test("file payloads record each import's resolution", () => {
  const file = { path: "src/main.c", sha: "1".repeat(40), size: 40, language: "c" } as CodeIndexFile;
  const facts = {
    language: "c",
    status: "ok",
    symbols: [],
    imports: [
      { source: "util.h", kind: "static", names: [], range: { start: { line: 1, column: 1 }, end: { line: 1, column: 18 } } },
      { source: "<stdio.h>", kind: "static", names: [], range: { start: { line: 2, column: 1 }, end: { line: 2, column: 19 } } },
      { source: "missing.h", kind: "static", names: [], range: { start: { line: 3, column: 1 }, end: { line: 3, column: 21 } } },
    ],
    exports: [],
    calls: [],
    stats: { lines: 3, nodeCount: 10, errorCount: 0, limitsHit: [] },
  } as unknown as CodeFacts;
  const known = new Set(["src/main.c", "src/util.h"]);
  const result = toFilePayload(file, facts, 40, known);
  assertEquals(result.imports.map((i) => [i.resolved_path, i.resolution]), [
    ["src/util.h", "resolved"],
    [null, "external"],
    [null, "unresolved"],
  ]);
  assertEquals(hydratePayload(result, new Set(["src/main.c"])).imports.map((i) => i.resolution), ["unresolved", "external", "unresolved"]);
});

Deno.test("linking turns resolver edges into replace_code_edges payloads", () => {
  const files: CodeLinkFile[] = [
    {
      path: "src/a.ts",
      language: "typescript",
      symbols: [{ name: "main", kind: "function", parent_ord: null, exported: true, signature: null }],
      imports: [{ source: "./b", kind: "static", names: ["helper"] }],
      calls: [
        { caller_ord: 0, callee_text: "helper" },
        { caller_ord: 0, callee_text: "dup" },
        { caller_ord: 0, callee_text: "nowhere" },
      ],
    },
    {
      path: "src/b.ts",
      language: "typescript",
      symbols: [
        { name: "helper", kind: "function", parent_ord: null, exported: true, signature: null },
        { name: "dup", kind: "function", parent_ord: null, exported: true, signature: null },
      ],
      imports: [],
      calls: [],
    },
    {
      path: "src/c.ts",
      language: "typescript",
      symbols: [{ name: "dup", kind: "function", parent_ord: null, exported: true, signature: null }],
      imports: [],
      calls: [],
    },
    {
      path: "src/d.ts",
      language: "typescript",
      symbols: [],
      imports: [],
      calls: [{ caller_ord: null, callee_text: "dup" }],
    },
  ];
  const { payloads, summary } = linkFiles(files, files.map((f) => f.path));
  assertEquals(payloads.map((p) => p.path), ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]);
  assertEquals(payloads[0].edges, [
    { call_ord: 0, target_path: "src/b.ts", target_ord: 0, confidence: "resolved", candidate_count: 1 },
    { call_ord: 1, target_path: "src/b.ts", target_ord: 1, confidence: "resolved", candidate_count: 1 },
  ], "an imported file's declaration wins over a same-named one elsewhere");
  assertEquals(payloads[1].edges, [], "files without calls are listed with no edges");
  assertEquals(payloads[3].edges, [
    { call_ord: 0, target_path: "src/b.ts", target_ord: 1, confidence: "ambiguous", candidate_count: 2 },
    { call_ord: 0, target_path: "src/c.ts", target_ord: 0, confidence: "ambiguous", candidate_count: 2 },
  ]);
  assertEquals(summary, { files: 4, edges_resolved: 2, edges_ambiguous: 1, calls_unresolved: 1, limits_hit: [] });
  assertEquals(linkFiles(files, files.map((f) => f.path)).payloads, payloads, "same input, same payloads");
});

Deno.test("edge payloads are batched by file count and row count", () => {
  const edge = { call_ord: 0, target_path: "x", target_ord: 0, confidence: "resolved" as const, candidate_count: 1 };
  const many = Array.from({ length: 250 }, (_, i) => ({ path: `f${i}`, edges: [] as typeof edge[] }));
  assertEquals(batchEdgePayloads(many).map((b) => b.length), [EDGE_BATCH_FILES, EDGE_BATCH_FILES, 50]);
  const heavy = Array.from({ length: 3 }, (_, i) => ({ path: `h${i}`, edges: Array.from({ length: 8000 }, (_, ord) => ({ ...edge, call_ord: ord })) }));
  assertEquals(batchEdgePayloads(heavy).map((b) => b.length), [2, 1]);
  assert(batchEdgePayloads(heavy).every((b) => b.reduce((n, f) => n + f.edges.length, 0) <= EDGE_BATCH_ROWS));
  assertEquals(batchEdgePayloads([]), []);
});

function payload(symbols: CodeFilePayload["symbols"], status: CodeFilePayload["parse_status"] = "ok"): CodeFilePayload {
  return {
    path: "src/svc.ts",
    blob_sha: "1".repeat(40),
    language: "typescript",
    size_bytes: 10,
    line_count: 30,
    parse_status: status,
    parse_error_count: 0,
    skipped_reason: null,
    stats: {},
    symbols,
    imports: [
      { source: "./db", kind: "static", names: ["db"], resolved_path: "src/db.ts", resolution: "resolved", line: 1 },
      { source: "./db", kind: "static", names: ["other"], resolved_path: "src/db.ts", resolution: "resolved", line: 2 },
    ],
    calls: [],
  };
}

const sym = (name: string, parent_ord: number | null, exported = false) => ({
  name,
  kind: parent_ord === null ? "function" as const : "method" as const,
  parent_ord,
  start_line: 1,
  start_col: 1,
  end_line: 2,
  end_col: 1,
  exported,
  signature: null,
});

Deno.test("outlines keep source order, name parents, and dedupe imports", () => {
  const outline = toOutline(payload([sym("Svc", null, true), sym("load", 0), sym("helper", null)]))!;
  assertEquals(outline.symbols.map((s) => [s.name, s.parent]), [["Svc", null], ["load", "Svc"], ["helper", null]]);
  assertEquals(outline.imports, [{ source: "./db", resolved_path: "src/db.ts" }]);
  assertEquals(toOutline(payload([], "skipped")), null, "files without facts have no outline");
});

Deno.test("outlines prefer exported and top-level symbols when capped", () => {
  const members = Array.from({ length: 60 }, (_, i) => sym(`m${i}`, 0));
  const outline = toOutline(payload([sym("Svc", null, true), ...members, sym("tail", null)]))!;
  assertEquals(outline.symbol_count, 62);
  assertEquals(outline.symbols.length, 40);
  assert(outline.symbols.some((s) => s.name === "tail"), "top-level symbols survive the cap");
});

function outline(path: string, names: string[], imports: FileOutline["imports"] = []): FileOutline {
  return {
    path,
    language: "typescript",
    lines: 10,
    symbols: names.map((name, i) => ({ name, kind: "function", parent: null, start_line: i + 1, end_line: i + 1, exported: true })),
    symbol_count: names.length,
    imports,
  };
}

Deno.test("code memory: one module row per directory and outline rows for files with symbols", () => {
  const outlines = [
    outline("src/auth/login.ts", ["login"], [{ source: "../db", resolved_path: "src/db.ts" }, { source: "jose", resolved_path: null }]),
    outline("src/auth/session.ts", ["refresh"]),
    outline("src/db.ts", []),
  ];
  const rows = buildCodeMemory(outlines, { commitSha: "a".repeat(40), parserVersion: "1" });
  assertEquals(rows.map((r) => `${r.kind}:${r.structured.path}`), [
    "code_module:src/auth/",
    "code_module:src/",
    "file_summary:src/auth/login.ts",
    "file_summary:src/auth/session.ts",
  ]);
  const auth = rows[0];
  assert(auth.content.includes("Exports: login (function, login.ts), refresh (function, session.ts)"));
  assert(auth.content.includes("Depends on: src/"));
  assert(auth.content.includes("External imports: jose"));
  assertEquals(auth.metadata, { source: "code_index", parser_version: "1", commit_sha: "a".repeat(40) });
  assert(rows[2].content.startsWith("src/auth/login.ts (typescript, 10 lines)\nSymbols: exported function login (line 1)"));
  assertEquals(buildCodeMemory(outlines, { commitSha: "a".repeat(40), parserVersion: "1" }), rows, "same input, same rows");
});

Deno.test("code memory is bounded and scrubbed", () => {
  const many = Array.from({ length: 120 }, (_, i) => outline(`d${String(i).padStart(3, "0")}/f.ts`, ["x"]));
  const rows = buildCodeMemory(many, { commitSha: "a".repeat(40), parserVersion: "1" });
  assertEquals(rows.filter((r) => r.kind === "code_module").length, CODE_MEMORY_LIMITS.maxModules);
  assertEquals(rows.filter((r) => r.kind === "file_summary").length, CODE_MEMORY_LIMITS.maxFileSummaries);
  assert(rows.every((r) => r.content.length <= CODE_MEMORY_LIMITS.maxContentChars));

  const secret = buildCodeMemory([outline("src/a.ts", ["sk_live_abcdefghijklmnop"])], { commitSha: "a".repeat(40), parserVersion: "1" });
  assert(!JSON.stringify(secret).includes("sk_live_abcdefghijklmnop"), "secret-looking names are scrubbed");
});

Deno.test("summary readers skip per-file and code index rows", () => {
  assertEquals(NON_SUMMARY_KINDS, "(file_summary,code_index,code_module)");
  assert(NON_SUMMARY_KIND_LIST.includes("code_module") && !NON_SUMMARY_KIND_LIST.includes("modules"));
});

Deno.test("pickFileSymbol matches name or Parent.name, exact case first", () => {
  const symbols: FileSymbol[] = [
    { name: "Login", kind: "class", parent: null, start_line: 1, end_line: 20, exported: true },
    { name: "login", kind: "method", parent: "Login", start_line: 2, end_line: 5, exported: false },
    { name: "login", kind: "function", parent: null, start_line: 30, end_line: 31, exported: false },
  ];
  assertEquals(pickFileSymbol(symbols, "login")?.start_line, 2, "first exact match in source order");
  assertEquals(pickFileSymbol(symbols, "Login")?.kind, "class");
  assertEquals(pickFileSymbol(symbols, "Login.login")?.kind, "method");
  assertEquals(pickFileSymbol(symbols, "LOGIN.LOGIN")?.kind, "method", "case-insensitive fallback");
  assertEquals(pickFileSymbol(symbols, "Other.login"), null);
  assertEquals(pickFileSymbol(symbols, "missing"), null);
});

Deno.test("selection is deterministic, skips excluded paths, and batches by files and bytes", () => {
  const entries = [
    { path: "src/b.ts", type: "blob" as const, sha: "b".repeat(40), size: 100 },
    { path: "src/a.ts", type: "blob" as const, sha: "a".repeat(40), size: 100 },
    { path: "src/huge.ts", type: "blob" as const, sha: "c".repeat(40), size: DEFAULT_CODE_INDEX_LIMITS.maxFileBytes + 1 },
    { path: "node_modules/x/index.js", type: "blob" as const, sha: "d".repeat(40), size: 10 },
    { path: "README.md", type: "blob" as const, sha: "e".repeat(40), size: 10 },
  ];
  const detect = (path: string) => (path.endsWith(".ts") || path.endsWith(".js") ? "typescript" : null);
  const selection = selectCodeFiles(entries, false, detect);
  assertEquals(selection.files.map((f) => [f.path, f.skip ?? null]), [["src/a.ts", null], ["src/b.ts", null], ["src/huge.ts", "too_large"]]);
  assertEquals(selectCodeFiles([...entries].reverse(), false, detect), selection, "input order does not matter");

  const limits = { ...DEFAULT_CODE_INDEX_LIMITS, batchFiles: 2, batchBytes: 150 };
  assertEquals(planBatches(selection.files, limits).map((b) => b.map((f) => f.path)), [["src/a.ts"], ["src/b.ts", "src/huge.ts"]]);
});
