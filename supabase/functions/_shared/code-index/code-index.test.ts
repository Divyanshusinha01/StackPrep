import { assert, assertEquals } from "@std/assert";
import type { CodeFilePayload, FileOutline } from "./mapper.ts";
import { resolveRelativeImport, toOutline } from "./mapper.ts";
import { buildCodeMemory, CODE_MEMORY_LIMITS, NON_SUMMARY_KIND_LIST, NON_SUMMARY_KINDS } from "./memory.ts";
import { type FileSymbol, pickFileSymbol } from "./reader.ts";
import { DEFAULT_CODE_INDEX_LIMITS, planBatches, selectCodeFiles } from "./select.ts";

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
  assertEquals(resolveRelativeImport("cmd/main.go", "go", "./internal", known), null, "other languages import packages");
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
      { source: "./db", kind: "static", names: ["db"], resolved_path: "src/db.ts", line: 1 },
      { source: "./db", kind: "static", names: ["other"], resolved_path: "src/db.ts", line: 2 },
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
