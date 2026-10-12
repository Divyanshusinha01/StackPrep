import { afterAll, describe, expect, it } from "vitest";
import {
  createCodeParser,
  createRegistry,
  defaultWasmLoader,
  detectLanguage,
  parseFile,
  python,
  type CodeFacts,
  type LanguageDefinition,
} from "../src/index.ts";

const parser = createCodeParser();
afterAll(() => parser.dispose());

const expectRangesValid = (facts: CodeFacts) => {
  const all = [...facts.symbols, ...facts.imports, ...facts.exports, ...facts.calls, ...facts.errors].map((f) => f.range);
  for (const r of all) {
    expect(r.start.line).toBeGreaterThanOrEqual(1);
    expect(r.start.column).toBeGreaterThanOrEqual(1);
    expect(r.end.line > r.start.line || (r.end.line === r.start.line && r.end.column >= r.start.column)).toBe(true);
  }
};

describe("ranges", () => {
  it("reports exact 1-based, end-exclusive line and column ranges", async () => {
    const facts = await parser.parseFile({ path: "a.ts", content: "function a() {\n  return b();\n}\n" });
    expect(facts.symbols[0]!.range).toEqual({ start: { line: 1, column: 1 }, end: { line: 3, column: 2 } });
    expect(facts.calls[0]!.range).toEqual({ start: { line: 2, column: 10 }, end: { line: 2, column: 13 } });
    expect(facts.stats.lines).toBe(3);
  });

  it("counts columns in UTF-16 code units", async () => {
    const facts = await parser.parseFile({ path: "a.ts", content: 'const s = "é😀"; function f() {}\n' });
    const f = facts.symbols.find((s) => s.name === "f")!;
    expect(f.range).toEqual({ start: { line: 1, column: 18 }, end: { line: 1, column: 33 } });
    expect(facts.stats.bytes).toBe(36);
  });

  it("treats CRLF as a single line break", async () => {
    const facts = await parser.parseFile({ path: "a.py", content: "def a():\r\n    pass\r\n\r\ndef b():\r\n    pass\r\n" });
    expect(facts.status).toBe("ok");
    expect(facts.symbols.map((s) => [s.name, s.range.start.line])).toEqual([["a", 1], ["b", 4]]);
    expect(facts.symbols[0]!.range.end).toEqual({ line: 2, column: 9 });
    expect(facts.stats.lines).toBe(5);
  });
});

describe("malformed and edge-case input", () => {
  it("returns partial facts and error ranges for broken syntax without throwing", async () => {
    const facts = await parser.parseFile({ path: "bad.ts", content: "export class { function ( => {{{{ <<< interface" });
    expect(facts.status).toBe("partial");
    expect(facts.reason).toBeNull();
    expect(facts.errors.length).toBeGreaterThan(0);
    expect(facts.stats.errorCount).toBeGreaterThanOrEqual(facts.errors.length);
    expectRangesValid(facts);
  });

  it("keeps facts from healthy regions of truncated files", async () => {
    const content = "import os\n\ndef ok():\n    return os.getcwd()\n\nclass Broken:\n    def m(self, \n";
    const facts = await parser.parseFile({ path: "trunc.py", content });
    expect(facts.status).toBe("partial");
    expect(facts.symbols.map((s) => s.name)).toContain("ok");
    expect(facts.imports.map((i) => i.source)).toEqual(["os"]);
    expectRangesValid(facts);
  });

  it("reports missing nodes", async () => {
    const facts = await parser.parseFile({ path: "a.go", content: "package a\nfunc f() {\n" });
    expect(facts.status).toBe("partial");
    expect(facts.errors.some((e) => e.kind === "missing" || e.kind === "error")).toBe(true);
  });

  it("handles binary-looking content", async () => {
    const facts = await parser.parseFile({ path: "a.go", content: "\u0000\u0001\u0002garbage\uFFFD func (" });
    expect(["partial", "ok"]).toContain(facts.status);
    expectRangesValid(facts);
  });

  it("handles an empty file", async () => {
    const facts = await parser.parseFile({ path: "Empty.java", content: "" });
    expect(facts).toMatchObject({ language: "java", status: "ok", reason: null, symbols: [], imports: [], exports: [], calls: [], errors: [] });
    expect(facts.stats).toMatchObject({ bytes: 0, lines: 0, errorCount: 0, limitsHit: [] });
  });

  it("skips oversized error nodes quickly instead of querying them", async () => {
    const start = performance.now();
    const facts = await parser.parseFile({ path: "deep.js", content: "(".repeat(20_000) });
    expect(performance.now() - start).toBeLessThan(1000);
    expect(facts.status).toBe("partial");
    expect(facts.stats.limitsHit).toContain("oversizedErrorNode");
  });

  it.each([
    ["broken.c", "int f( {\n#include \nstruct { int x;\nvoid g(void) { h(; }\n"],
    ["broken.cpp", "namespace a { class B : public { void m() { this->; } template <typename> }\n"],
    ["broken.h", "#ifndef X\n#define X\nint f(int a,\n"],
    ["macros.c", "#define CALL(x) x()\nCALL(foo)\nint MACRO_FN(a, b) { return 0; }\n"],
  ])("returns facts without throwing for malformed C/C++ (%s)", async (path, content) => {
    const facts = await parser.parseFile({ path, content });
    expect(["ok", "partial"]).toContain(facts.status);
    expect(facts.reason).toBeNull();
    expectRangesValid(facts);
  });

  it("keeps healthy C functions around an error", async () => {
    const content = "int before(void) { return 1; }\nint broken( {\nint after(void) { return before(); }\n";
    const facts = await parser.parseFile({ path: "a.c", content });
    expect(facts.status).toBe("partial");
    expect(facts.symbols.map((s) => s.name)).toEqual(expect.arrayContaining(["before"]));
  });

  it("still extracts healthy code before and after a small error", async () => {
    const content = "function before() {}\nconst x = (;\nfunction after() {}\n";
    const facts = await parser.parseFile({ path: "a.js", content });
    expect(facts.status).toBe("partial");
    expect(facts.symbols.map((s) => s.name)).toEqual(expect.arrayContaining(["before", "after"]));
  });
});

describe("limits", () => {
  it("fails files over maxBytes measured in UTF-8 bytes", async () => {
    const facts = await parser.parseFile({ path: "a.py", content: `s = "${"é".repeat(600)}"\n`, limits: { maxBytes: 1000 } });
    expect(facts).toMatchObject({ status: "failed", reason: "too_large", symbols: [] });
    expect(facts.stats.limitsHit).toEqual(["maxBytes"]);
    expect(facts.stats.bytes).toBe(1207);
  });

  it("fails trees over maxNodes", async () => {
    const facts = await parser.parseFile({ path: "a.ts", content: "const a = [1, 2, 3, 4, 5, 6, 7, 8];", limits: { maxNodes: 10 } });
    expect(facts).toMatchObject({ status: "failed", reason: "too_many_nodes" });
    expect(facts.stats.nodeCount).toBeGreaterThan(10);
  });

  it("stops at the timeout", async () => {
    const content = "const a = [" + "f(1), ".repeat(80_000) + "];";
    const facts = await parser.parseFile({ path: "big.js", content, limits: { timeoutMs: 1, maxBytes: 2_000_000, maxNodes: 10_000_000 } });
    expect(["failed", "partial"]).toContain(facts.status);
    expect(facts.stats.limitsHit).toContain("timeout");
  });

  it("caps facts and records which caps were hit", async () => {
    const content = Array.from({ length: 30 }, (_, i) => `function f${i}() { g(); h(); }`).join("\n");
    const facts = await parser.parseFile({ path: "a.ts", content, limits: { maxSymbols: 5, maxCalls: 7, maxExports: 1 } });
    expect(facts.status).toBe("ok");
    expect(facts.symbols).toHaveLength(5);
    expect(facts.calls).toHaveLength(7);
    expect(facts.stats.limitsHit).toEqual(["maxCalls", "maxSymbols"]);
  });

  it("caps error facts while counting all errors", async () => {
    const content = Array.from({ length: 20 }, (_, i) => `function f${i}() { const a = ; }`).join("\n");
    const facts = await parser.parseFile({ path: "a.js", content, limits: { maxErrors: 2 } });
    expect(facts.errors).toHaveLength(2);
    expect(facts.stats.errorCount).toBeGreaterThan(2);
    expect(facts.stats.limitsHit).toContain("maxErrors");
  });

  it("rejects invalid limit configuration", async () => {
    await expect(parser.parseFile({ path: "a.py", content: "", limits: { timeoutMs: 0 } })).rejects.toThrow(RangeError);
  });
});

describe("unsupported languages and grammar failures", () => {
  it("returns unsupported for unknown paths and language ids", async () => {
    expect(await parser.parseFile({ path: "main.rs", content: "fn main() {}" })).toMatchObject({ language: null, status: "unsupported", reason: "no_language" });
    expect(await parser.parseFile({ path: "main.m", content: "@interface A @end" })).toMatchObject({ language: null, status: "unsupported", reason: "no_language" });
    expect(await parser.parseFile({ language: "cobol", content: "x" })).toMatchObject({ language: "cobol", status: "unsupported", reason: "no_language" });
    expect(await parser.parseFile({ content: "x" })).toMatchObject({ status: "unsupported", reason: "no_language" });
  });

  it("prefers an explicit language over the path", async () => {
    const facts = await parser.parseFile({ path: "script.txt", language: "python", content: "def a(): pass\n" });
    expect(facts.language).toBe("python");
    expect(facts.symbols.map((s) => s.name)).toEqual(["a"]);
  });

  it("marks a language unsupported when its grammar fails to load while others keep working", async () => {
    const broken = createCodeParser({
      loadWasm: (file) => (file === "tree-sitter-go.wasm" ? Promise.reject(new Error("missing grammar")) : defaultWasmLoader(file)),
    });
    try {
      expect(await broken.parseFile({ path: "a.go", content: "package a" })).toMatchObject({ language: "go", status: "unsupported", reason: "grammar_unavailable" });
      expect((await broken.parseFile({ path: "a.py", content: "def a(): pass" })).status).toBe("ok");
      const preload = await broken.preload(["go", "python", "nope"]);
      expect(preload).toEqual({ go: "missing grammar", python: null, nope: "unknown language" });
    } finally {
      broken.dispose();
    }
  });

  it("contains corrupt grammar bytes and invalid queries", async () => {
    const corrupt: LanguageDefinition = { ...python, id: "corrupt", extensions: [".corrupt"], grammar: async () => new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 255]) };
    const badQuery: LanguageDefinition = { ...python, id: "badquery", extensions: [".bq"], queries: { facts: "(not_a_node) @x" } };
    const custom = createCodeParser({ registry: createRegistry([corrupt, badQuery]) });
    try {
      expect((await custom.parseFile({ path: "a.corrupt", content: "x = 1" })).reason).toBe("grammar_unavailable");
      expect((await custom.parseFile({ path: "a.bq", content: "x = 1" })).reason).toBe("grammar_unavailable");
    } finally {
      custom.dispose();
    }
  });

  it("supports custom language definitions through the registry", async () => {
    const functionsOnly: LanguageDefinition = {
      id: "py-functions",
      extensions: [".py"],
      grammar: "tree-sitter-python.wasm",
      queries: { facts: "(function_definition name: (identifier) @name) @definition.function" },
    };
    const custom = createCodeParser({ registry: createRegistry([functionsOnly]) });
    try {
      const facts = await custom.parseFile({ path: "a.py", content: "import os\nclass A:\n    def m(self): pass\ndef f(): pass\n" });
      expect(facts.language).toBe("py-functions");
      expect(facts.symbols.map((s) => [s.name, s.kind, s.exported])).toEqual([["m", "function", false], ["f", "function", false]]);
      expect(facts.imports).toEqual([]);
    } finally {
      custom.dispose();
    }
  });
});

describe("determinism and multi-language use", () => {
  const files = [
    { path: "a.ts", content: "export class A { m() { return f(); } }\nimport { f } from './f';\n" },
    { path: "b.tsx", content: "export const B = () => <div>{g()}</div>;\n" },
    { path: "c.js", content: "const x = require('x');\nfunction c() { return x(); }\n" },
    { path: "d.py", content: "from x import y\ndef d():\n    return y()\n" },
    { path: "E.java", content: "public class E { public void e() { run(); } }\n" },
    { path: "f.go", content: "package f\nimport \"fmt\"\nfunc F() { fmt.Println() }\n" },
    { path: "g.c", content: "#include \"g.h\"\nint g(void) { return h(); }\n" },
    { path: "h.cpp", content: "namespace n { int H() { return n::g(); } }\n" },
  ];

  it("returns identical output for identical input across runs and parser instances", async () => {
    const other = createCodeParser();
    try {
      for (const file of files) {
        const first = await parser.parseFile(file);
        const second = await parser.parseFile(file);
        const third = await other.parseFile(file);
        expect(second).toEqual(first);
        expect(JSON.stringify(third)).toBe(JSON.stringify(first));
      }
    } finally {
      other.dispose();
    }
  });

  it("parses a mixed-language batch concurrently", async () => {
    const results = await Promise.all(files.map((f) => parser.parseFile(f)));
    expect(results.map((r) => [r.language, r.status])).toEqual([
      ["typescript", "ok"], ["tsx", "ok"], ["javascript", "ok"], ["python", "ok"], ["java", "ok"], ["go", "ok"], ["c", "ok"], ["cpp", "ok"],
    ]);
    expect(results.every((r) => r.symbols.length > 0 && r.calls.length > 0)).toBe(true);
  });

  it("exposes module-level helpers backed by the default registry", async () => {
    expect(detectLanguage("x/y.go")).toBe("go");
    expect((await parseFile({ path: "x.py", content: "def a(): pass\n" })).symbols[0]!.name).toBe("a");
  });
});
