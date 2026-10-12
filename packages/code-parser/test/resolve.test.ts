import { afterAll, describe, expect, it } from "vitest";
import {
  createCodeParser,
  parseCallee,
  resolveImport,
  resolveProject,
  signatureQualifier,
  type CallEdge,
  type ProjectFile,
  type ProjectGraph,
  type ResolveOptions,
} from "../src/index.ts";

const parser = createCodeParser();
afterAll(() => parser.dispose());

async function parseAll(sources: Record<string, string>): Promise<ProjectFile[]> {
  return Promise.all(Object.entries(sources).map(async ([path, content]) => {
    const facts = await parser.parseFile({ path, content });
    return { path, language: facts.language, facts };
  }));
}

async function project(sources: Record<string, string>, options?: ResolveOptions) {
  const files = await parseAll(sources);
  return { files, graph: resolveProject({ files }, options) };
}

/** `confidence path#name` for the call with this callee text in `file` (nth occurrence). */
function edge(graph: ProjectGraph, files: ProjectFile[], file: string, callee: string, nth = 0): string {
  const e = graph.calls.filter((c) => c.fromFile === file && c.calleeText === callee)[nth];
  if (!e) throw new Error(`no call ${callee} in ${file}`);
  return describeEdge(e, files);
}

function describeEdge(e: CallEdge, files: ProjectFile[]): string {
  const name = (file: string, symbol: number) => `${file}#${files.find((f) => f.path === file)!.facts.symbols[symbol]!.name}`;
  if (e.confidence === "resolved") return `resolved ${name(e.toFile!, e.toSymbol!)} via ${e.via}`;
  if (e.confidence === "ambiguous") return `ambiguous ${e.candidates.map((c) => name(c.file, c.symbol)).join(",")} (${e.candidateCount}) via ${e.via}`;
  return "unresolved";
}

const importOf = (graph: ProjectGraph, file: string, source: string) => {
  const imp = graph.imports.find((i) => i.file === file && i.source === source)!;
  return { resolution: imp.resolution, resolvedPath: imp.resolvedPath, candidates: imp.candidates };
};

describe("parseCallee and signatureQualifier", () => {
  it.each([
    ["foo", { name: "foo", qualifier: [] }],
    ["this.db.from", { name: "from", qualifier: ["this", "db"] }],
    ["ns::fn", { name: "fn", qualifier: ["ns"] }],
    ["::global", { name: "global", qualifier: [] }],
    ["s->ops.get", { name: "get", qualifier: ["s", "ops"] }],
    ["std::make_shared<a::B>", { name: "make_shared", qualifier: ["std"] }],
    ["z.string().parse", { name: "parse", qualifier: null }],
  ])("parses %s", (text, expected) => {
    expect(parseCallee(text)).toEqual(expected);
  });

  it("rejects callees without an identifier name", () => {
    expect(parseCallee("(a || b)")).toBeNull();
  });

  it("reads C++ out-of-line qualifiers from signatures", () => {
    expect(signatureQualifier("int app::Store::get(int key) const", "get")).toEqual(["app", "Store"]);
    expect(signatureQualifier("Box<T>::~Box()", "~Box")).toEqual(["Box"]);
    expect(signatureQualifier("int get(int key)", "get")).toEqual([]);
    expect(signatureQualifier(null, "get")).toEqual([]);
  });
});

describe("resolveImport", () => {
  const known = new Set([
    "src/db.ts", "src/lib/index.ts", "src/util.js",
    "app/models.py", "app/__init__.py", "src/pkg/core.py", "lib/pkg/core.py",
    "internal/store/store.go", "internal/store/helpers.go", "cmd/main.go",
    "src/main/java/com/acme/Store.java", "src/main/java/com/acme/app/App.java",
    "include/store.h", "src/store.c", "src/local.h", "a/dup.h", "b/dup.h",
  ]);

  it.each([
    ["src/app.ts", "typescript", "./db", [], "resolved", "src/db.ts"],
    ["src/app.ts", "typescript", "./lib", [], "resolved", "src/lib/index.ts"],
    ["src/app.ts", "typescript", "./util.js", [], "resolved", "src/util.js"],
    ["src/app.ts", "typescript", "./missing", [], "unresolved", null],
    ["src/app.ts", "typescript", "zod", [], "external", null],
    ["app/service.py", "python", ".models", [], "resolved", "app/models.py"],
    ["app/service.py", "python", "app.models", [], "resolved", "app/models.py"],
    ["app/service.py", "python", "os.path", [], "external", null],
    ["cmd/main.go", "go", "github.com/acme/app/internal/store", [], "resolved", "internal/store/"],
    ["cmd/main.go", "go", "fmt", [], "external", null],
    ["cmd/main.go", "go", "github.com/other/lib", [], "external", null],
    ["src/main/java/com/acme/app/App.java", "java", "com.acme.Store", ["Store"], "resolved", "src/main/java/com/acme/Store.java"],
    ["src/main/java/com/acme/app/App.java", "java", "com.acme.Store.make", ["make"], "resolved", "src/main/java/com/acme/Store.java"],
    ["src/main/java/com/acme/app/App.java", "java", "com.acme", ["*"], "resolved", "src/main/java/com/acme/"],
    ["src/main/java/com/acme/app/App.java", "java", "java.util.List", ["List"], "external", null],
    ["src/store.c", "c", "store.h", [], "resolved", "include/store.h"],
    ["src/store.c", "c", "local.h", [], "resolved", "src/local.h"],
    ["src/store.c", "c", "include/store.h", [], "resolved", "include/store.h"],
    ["src/store.c", "c", "<stdio.h>", [], "external", null],
    ["src/store.c", "c", "missing.h", [], "unresolved", null],
    ["src/store.c", "rust", "anything", [], "unresolved", null],
  ])("%s: %s %s", (from, language, source, names, resolution, resolvedPath) => {
    const target = resolveImport(from, language, source, known, names);
    expect(target.resolution).toBe(resolution);
    expect(target.resolvedPath).toBe(resolvedPath);
  });

  it("reports ambiguous suffix matches with their candidates and binds nothing", () => {
    expect(resolveImport("src/x.py", "python", "pkg.core", known)).toEqual({
      resolvedPath: null, resolution: "ambiguous", candidates: ["lib/pkg/core.py", "src/pkg/core.py"], files: [],
    });
    expect(resolveImport("src/x.c", "c", "dup.h", known).candidates).toEqual(["a/dup.h", "b/dup.h"]);
  });

  it("brings every package file into scope for a Go import", () => {
    expect(resolveImport("cmd/main.go", "go", "acme/internal/store", known).files).toEqual([
      "internal/store/helpers.go", "internal/store/store.go",
    ]);
  });
});

describe("ECMAScript call graph", () => {
  const sources = {
    "src/db.ts": `export function query(sql: string) { return sql; }
export class Db {
  static create() { return new Db(); }
  from(table: string) { return query(table); }
}
`,
    "src/index.ts": `export * from "./db";\n`,
    "src/service.ts": `import { query, Db } from "./db";
import * as dbns from "./db";
export class Service {
  run() { return this.load(); }
  load() { return query("x") + helper(); }
  make() { return Db.create(); }
  viaNamespace() { return dbns.query("y"); }
  unknown() { return fetch("/"); }
}
function helper() { return 1; }
`,
    "src/app.ts": `import { query } from "./index";\nexport const main = () => query("z");\n`,
  };

  it("resolves imported names, static members, this-calls, namespaces, re-exports and local helpers", async () => {
    const { files, graph } = await project(sources);
    expect(edge(graph, files, "src/service.ts", "this.load")).toBe("resolved src/service.ts#load via member");
    expect(edge(graph, files, "src/service.ts", "query")).toBe("resolved src/db.ts#query via import");
    expect(edge(graph, files, "src/service.ts", "helper")).toBe("resolved src/service.ts#helper via local");
    expect(edge(graph, files, "src/service.ts", "Db.create")).toBe("resolved src/db.ts#create via import");
    expect(edge(graph, files, "src/service.ts", "dbns.query")).toBe("resolved src/db.ts#query via import");
    expect(edge(graph, files, "src/app.ts", "query")).toBe("resolved src/db.ts#query via import");
    expect(edge(graph, files, "src/db.ts", "query")).toBe("resolved src/db.ts#query via local");
    expect(edge(graph, files, "src/db.ts", "Db")).toBe("resolved src/db.ts#Db via local");
    expect(edge(graph, files, "src/service.ts", "fetch")).toBe("unresolved");
  });

  it("answers callers and callees of a symbol", async () => {
    const { files, graph } = await project(sources);
    const db = files.find((f) => f.path === "src/db.ts")!;
    const queryOrd = db.facts.symbols.findIndex((s) => s.name === "query");
    expect(graph.callersOf("src/db.ts", queryOrd).map((e) => `${e.fromFile}:${e.calleeText}`).sort()).toEqual([
      "src/app.ts:query", "src/db.ts:query", "src/service.ts:dbns.query", "src/service.ts:query",
    ]);
    const service = files.find((f) => f.path === "src/service.ts")!;
    const loadOrd = service.facts.symbols.findIndex((s) => s.name === "load");
    expect(graph.calleesOf("src/service.ts", loadOrd).map((e) => e.calleeText)).toEqual(["query", "helper"]);
  });
});

describe("Python call graph", () => {
  it("resolves relative, absolute and submodule imports plus self-calls", async () => {
    const { files, graph } = await project({
      "app/__init__.py": "",
      "app/models.py": "class User:\n    def save(self):\n        return self.validate()\n    def validate(self):\n        return True\n\ndef load(id):\n    return User()\n",
      "app/service.py": "from .models import load\nfrom app import models\nimport app.models\n\ndef handle(id):\n    u = load(id)\n    models.load(id)\n    app.models.load(id)\n    return u.save()\n",
    });
    expect(edge(graph, files, "app/models.py", "self.validate")).toBe("resolved app/models.py#validate via member");
    expect(edge(graph, files, "app/models.py", "User")).toBe("resolved app/models.py#User via local");
    expect(edge(graph, files, "app/service.py", "load")).toBe("resolved app/models.py#load via import");
    expect(edge(graph, files, "app/service.py", "models.load")).toBe("resolved app/models.py#load via import");
    expect(edge(graph, files, "app/service.py", "app.models.load")).toBe("resolved app/models.py#load via import");
    expect(edge(graph, files, "app/service.py", "u.save")).toBe("resolved app/models.py#save via reachable");
  });
});

describe("Go call graph", () => {
  it("resolves package-qualified calls and same-package siblings", async () => {
    const { files, graph } = await project({
      "internal/store/store.go": "package store\n\ntype Store struct{}\n\nfunc New() *Store { return &Store{} }\n\nfunc (s *Store) Find(id string) error { return check(id) }\n",
      "internal/store/helpers.go": "package store\n\nfunc check(id string) error { return nil }\n",
      "cmd/main.go": "package main\n\nimport (\n\t\"fmt\"\n\tst \"github.com/acme/app/internal/store\"\n)\n\nfunc main() { s := st.New(); fmt.Println(s.Find(\"x\")) }\n",
    });
    expect(importOf(graph, "cmd/main.go", "github.com/acme/app/internal/store")).toEqual({ resolution: "resolved", resolvedPath: "internal/store/", candidates: [] });
    expect(importOf(graph, "cmd/main.go", "fmt").resolution).toBe("external");
    expect(edge(graph, files, "cmd/main.go", "st.New")).toBe("resolved internal/store/store.go#New via import");
    expect(edge(graph, files, "internal/store/store.go", "check")).toBe("resolved internal/store/helpers.go#check via local");
    expect(edge(graph, files, "cmd/main.go", "s.Find")).toBe("resolved internal/store/store.go#Find via reachable");
    expect(edge(graph, files, "cmd/main.go", "fmt.Println")).toBe("unresolved");
  });
});

describe("Java call graph", () => {
  it("resolves imported classes, static members, constructors, sibling classes and bare member calls", async () => {
    const { files, graph } = await project({
      "src/main/java/com/acme/Store.java": "package com.acme;\npublic class Store {\n  public static Store make() { return new Store(); }\n  public void save() { validate(); }\n  private void validate() {}\n}\n",
      "src/main/java/com/acme/app/Helper.java": "package com.acme.app;\nclass Helper { static int one() { return 1; } }\n",
      "src/main/java/com/acme/app/App.java": "package com.acme.app;\nimport com.acme.Store;\nimport java.util.List;\npublic class App {\n  void run() { Store s = Store.make(); new Store(); new Helper(); s.save(); }\n}\n",
    });
    const app = "src/main/java/com/acme/app/App.java";
    expect(edge(graph, files, app, "Store.make")).toBe("resolved src/main/java/com/acme/Store.java#make via import");
    expect(edge(graph, files, app, "Store")).toBe("resolved src/main/java/com/acme/Store.java#Store via import");
    expect(edge(graph, files, app, "Helper")).toBe("resolved src/main/java/com/acme/app/Helper.java#Helper via local");
    expect(edge(graph, files, app, "s.save")).toBe("resolved src/main/java/com/acme/Store.java#save via reachable");
    expect(edge(graph, files, "src/main/java/com/acme/Store.java", "validate")).toBe("resolved src/main/java/com/acme/Store.java#validate via member");
    expect(importOf(graph, app, "java.util.List").resolution).toBe("external");
  });
});

describe("C call graph", () => {
  const sources = {
    "include/store.h": "#ifndef STORE_H\n#define STORE_H\nint store_get(int key);\nint store_put(int key, int value);\n#endif\n",
    "include/api.h": "#include \"store.h\"\nvoid api_init(void);\n",
    "src/store.c": "#include \"store.h\"\nstatic int helper(int k);\nint store_get(int key) { return helper(key); }\nint store_put(int key, int value) { return store_get(key) + value; }\nstatic int helper(int k) { return k; }\n",
    "src/main.c": "#include <stdio.h>\n#include \"store.h\"\nint main(void) { printf(\"%d\", store_get(1)); return helper(2); }\n",
    "src/other.c": "#include \"api.h\"\nvoid api_init(void) { store_put(1, 2); }\n",
  };

  it("links calls through headers to their source definitions", async () => {
    const { files, graph } = await project(sources);
    expect(importOf(graph, "src/main.c", "store.h")).toEqual({ resolution: "resolved", resolvedPath: "include/store.h", candidates: [] });
    expect(importOf(graph, "src/main.c", "<stdio.h>").resolution).toBe("external");
    expect(edge(graph, files, "src/main.c", "store_get")).toBe("resolved src/store.c#store_get via import");
    expect(edge(graph, files, "src/other.c", "store_put")).toBe("resolved src/store.c#store_put via import");
    expect(edge(graph, files, "src/store.c", "store_get")).toBe("resolved src/store.c#store_get via import");
    expect(edge(graph, files, "src/main.c", "printf")).toBe("unresolved");
  });

  it("prefers a static function's definition over its forward declaration and hides it from other files", async () => {
    const { files, graph } = await project(sources);
    const e = graph.calls.find((c) => c.fromFile === "src/store.c" && c.calleeText === "helper")!;
    expect(describeEdge(e, files)).toBe("resolved src/store.c#helper via local");
    expect(files.find((f) => f.path === "src/store.c")!.facts.symbols[e.toSymbol!]!.signature).toBe("static int helper(int k)");
    expect(edge(graph, files, "src/main.c", "helper")).toBe("unresolved");
  });
});

describe("C++ call graph", () => {
  const sources = {
    "include/app/store.hpp": `#pragma once
namespace app {
class Store {
 public:
  int get(int key);
  static Store make();
  int twice(int key) { return this->get(key) * 2; }
};
int identity(int v);
}
`,
    "src/store.cpp": `#include "app/store.hpp"
int app::Store::get(int key) { return identity(key); }
namespace app {
int identity(int v) { return v; }
Store Store::make() { return Store(); }
}
`,
    "src/main.cpp": `#include "app/store.hpp"
int main() {
  auto s = app::Store::make();
  return s.get(1) + app::identity(2) + missing::fn();
}
`,
  };

  it("links header declarations to out-of-line definitions by name and qualifier", async () => {
    const { files, graph } = await project(sources);
    expect(edge(graph, files, "src/main.cpp", "app::Store::make")).toBe("resolved src/store.cpp#make via qualified");
    expect(edge(graph, files, "src/main.cpp", "s.get")).toBe("resolved src/store.cpp#get via reachable");
    expect(edge(graph, files, "src/main.cpp", "app::identity")).toBe("resolved src/store.cpp#identity via qualified");
    expect(edge(graph, files, "src/main.cpp", "missing::fn")).toBe("unresolved");
  });

  it("resolves calls inside out-of-line methods and inline this-calls", async () => {
    const { files, graph } = await project(sources);
    expect(edge(graph, files, "src/store.cpp", "identity")).toBe("resolved src/store.cpp#identity via import");
    expect(edge(graph, files, "include/app/store.hpp", "this.get")).toBe("resolved src/store.cpp#get via member");
  });
});

describe("ambiguity, unresolved and unsupported input", () => {
  it("marks name-only matches outside imports as ambiguous with capped candidates", async () => {
    const sources: Record<string, string> = { "src/use.ts": "export function use() { format(); render(); }\n" };
    for (let i = 0; i < 7; i++) sources[`src/f${i}.ts`] = "export function format() {}\n";
    sources["src/r.ts"] = "export function render() {}\n";
    const { files, graph } = await project(sources, { maxCandidates: 3 });
    const format = graph.calls.find((c) => c.calleeText === "format")!;
    expect(format).toMatchObject({ confidence: "ambiguous", via: "global", candidateCount: 7, toFile: null, toSymbol: null });
    expect(format.candidates.map((c) => c.file)).toEqual(["src/f0.ts", "src/f1.ts", "src/f2.ts"]);
    expect(edge(graph, files, "src/use.ts", "render")).toBe("ambiguous src/r.ts#render (1) via global");
  });

  it("keeps ambiguous imports unbound and does not let private symbols match globally", async () => {
    const { files, graph } = await project({
      "a/pkg/core.py": "def run():\n    pass\n",
      "b/pkg/core.py": "def run():\n    pass\n",
      "main.py": "import pkg.core\n\ndef go():\n    pkg.core.run()\n    _hidden()\n",
      "other.py": "def _hidden():\n    pass\n",
    });
    expect(importOf(graph, "main.py", "pkg.core")).toEqual({ resolution: "ambiguous", resolvedPath: null, candidates: ["a/pkg/core.py", "b/pkg/core.py"] });
    expect(edge(graph, files, "main.py", "pkg.core.run")).toBe("ambiguous a/pkg/core.py#run,b/pkg/core.py#run (2) via global");
    expect(edge(graph, files, "main.py", "_hidden")).toBe("unresolved");
  });

  it("gives unsupported, failed and unknown-language files unresolved edges without throwing", async () => {
    const parsed = await parseAll({ "src/a.ts": "export function a() {}\n", "src/broken.ts": "export class { function ( => {{{{" });
    const files: ProjectFile[] = [
      ...parsed,
      { path: "src/main.rs", language: null, facts: { symbols: [], imports: [{ source: "crate::x", names: [], kind: "static" }], calls: [{ calleeText: "x::y", enclosingSymbolIndex: null }] } },
      { path: "src/big.ts", language: "typescript", facts: { symbols: [], imports: [], calls: [] } },
      { path: "src/weird.kt", language: "kotlin", facts: { symbols: [], imports: [], calls: [{ calleeText: "(a || b)", enclosingSymbolIndex: 7 }] } },
    ];
    const graph = resolveProject({ files });
    expect(graph.imports.find((i) => i.file === "src/main.rs")!.resolution).toBe("unresolved");
    expect(graph.calls.filter((c) => c.fromFile !== "src/broken.ts").map((c) => `${c.fromFile}:${c.confidence}`)).toEqual([
      "src/main.rs:unresolved", "src/weird.kt:unresolved",
    ]);
  });
});

describe("determinism and limits", () => {
  const sources = {
    "src/a.ts": "import { b } from './b';\nexport function a() { b(); c(); a(); }\n",
    "src/b.ts": "export function b() { return 1; }\n",
    "src/c.ts": "export function c() { return 2; }\n",
  };

  it("returns identical graphs regardless of input order", async () => {
    const files = await parseAll(sources);
    const first = resolveProject({ files });
    const second = resolveProject({ files: [...files].reverse() });
    expect(JSON.stringify(second.calls)).toBe(JSON.stringify(first.calls));
    expect(JSON.stringify(second.imports)).toBe(JSON.stringify(first.imports));
    expect(first.limitsHit).toEqual([]);
  });

  it("stops at maxEdges and records the limit", async () => {
    const files = await parseAll(sources);
    const graph = resolveProject({ files }, { maxEdges: 2 });
    expect(graph.calls).toHaveLength(2);
    expect(graph.limitsHit).toEqual(["maxEdges"]);
  });

  it("degrades to unresolved edges once the time budget is spent", async () => {
    const calls = Array.from({ length: 300 }, () => ({ calleeText: "a", enclosingSymbolIndex: 0 }));
    const files: ProjectFile[] = [{
      path: "src/a.ts",
      language: "typescript",
      facts: { symbols: [{ name: "a", kind: "function", parentIndex: null, exported: true, signature: "function a()" }], imports: [], calls },
    }];
    // The clock is read once up front and then every 128 calls: 100, 200 (within 250), 300 (over).
    let t = 0;
    const graph = resolveProject({ files }, { timeBudgetMs: 150, now: () => (t += 100) });
    expect(graph.calls).toHaveLength(300);
    expect(graph.limitsHit).toEqual(["timeBudget"]);
    expect(graph.calls[254]!.confidence).toBe("resolved");
    expect(graph.calls[255]!.confidence).toBe("unresolved");
    expect(graph.calls[299]!.confidence).toBe("unresolved");
  });
});
