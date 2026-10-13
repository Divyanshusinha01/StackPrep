import { afterAll, describe, expect, it } from "vitest";
import { createCodeParser, detectLanguage, looksLikeCpp } from "../src/index.ts";
import { callRows, exportRows, importRows, symbolRows } from "./helpers.ts";

const parser = createCodeParser();
afterAll(() => parser.dispose());

describe("C headers", () => {
  const header = `#ifndef STORE_H
#define STORE_H
#include <stddef.h>
#include "types.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct store store_t;
typedef int (*store_cb)(void *ctx);
struct entry { int key; };
enum mode { MODE_A, MODE_B };

extern int store_count;
store_t *store_open(const char *path);
int store_get(store_t *s, int key);
static inline int store_ok(int rc) { return rc == 0; }

#ifdef __cplusplus
}
#endif
#endif
`;

  it("treats include-guarded prototypes as exported function declarations", async () => {
    const facts = await parser.parseFile({ path: "include/store.h", content: header });
    expect(facts.language).toBe("c");
    // The `extern "C" {` split across preprocessor branches leaves one missing `}` in the tree.
    expect(facts.status).toBe("partial");
    expect(facts.errors.map((e) => e.kind)).toEqual(["missing"]);
    expect(symbolRows(facts)).toEqual([
      { name: "store_t", kind: "type", parent: null, exported: true },
      { name: "store_cb", kind: "type", parent: null, exported: true },
      { name: "entry", kind: "class", parent: null, exported: true },
      { name: "mode", kind: "enum", parent: null, exported: true },
      { name: "store_count", kind: "variable", parent: null, exported: true },
      { name: "store_open", kind: "function", parent: null, exported: true },
      { name: "store_get", kind: "function", parent: null, exported: true },
      { name: "store_ok", kind: "function", parent: null, exported: false },
    ]);
  });

  it("keeps quoted includes as written and angle includes with their brackets", async () => {
    const facts = await parser.parseFile({ path: "include/store.h", content: header });
    expect(importRows(facts)).toEqual([
      { source: "<stddef.h>", names: [], kind: "static" },
      { source: "types.h", names: [], kind: "static" },
    ]);
  });

  it("marks prototypes with a trailing semicolon signature and definitions without", async () => {
    const facts = await parser.parseFile({ path: "include/store.h", content: header });
    const sig = (name: string) => facts.symbols.find((s) => s.name === name)?.signature;
    expect(sig("store_get")).toBe("int store_get(store_t *s, int key);");
    expect(sig("store_ok")).toBe("static inline int store_ok(int rc)");
  });
});

describe("C sources", () => {
  const source = `#include "store.h"

static int helper(int a);
const int MAX_KEYS = 64;
static int opened = 0;

store_t *store_open(const char *path) {
  int local = helper(1);
  opened++;
  return make_store(path, local);
}

int store_get(store_t *s, int key) {
  if (s->cb) s->cb(s);
  return s->ops.get(s, key) + helper(key);
}

static int helper(int a) { return a; }
`;

  it("separates definitions from declarations and ignores block-scope variables", async () => {
    const facts = await parser.parseFile({ path: "src/store.c", content: source });
    expect(symbolRows(facts)).toEqual([
      { name: "helper", kind: "function", parent: null, exported: false },
      { name: "MAX_KEYS", kind: "constant", parent: null, exported: true },
      { name: "opened", kind: "variable", parent: null, exported: false },
      { name: "store_open", kind: "function", parent: null, exported: true },
      { name: "store_get", kind: "function", parent: null, exported: true },
      { name: "helper", kind: "function", parent: null, exported: false },
    ]);
    expect(exportRows(facts).map((e) => e.name)).toEqual(["MAX_KEYS", "store_open", "store_get"]);
  });

  it("extracts direct, member and pointer-member calls", async () => {
    const facts = await parser.parseFile({ path: "src/store.c", content: source });
    expect(callRows(facts)).toEqual([
      { callee: "helper", in: "store_open" },
      { callee: "make_store", in: "store_open" },
      { callee: "s.cb", in: "store_get" },
      { callee: "s->ops.get", in: "store_get" },
      { callee: "helper", in: "store_get" },
    ]);
  });

  it("tells pointer-returning functions from function pointers through nested declarators", async () => {
    const content = "char **split(const char *s) { return 0; }\nint *(*table)(void);\nint (*handler(int sig))(int);\nint a, *b, c[4];\n";
    const facts = await parser.parseFile({ path: "a.c", content });
    expect(facts.symbols.map((s) => [s.name, s.kind])).toEqual([
      ["split", "function"],
      ["table", "variable"],
      ["handler", "function"],
      ["a", "variable"],
      ["b", "variable"],
      ["c", "variable"],
    ]);
  });
});

describe("C++", () => {
  const content = `#pragma once
#include <vector>
#include "base.hpp"

extern "C" { int c_entry(void); }

namespace app {
namespace {
int hidden() { return 0; }
}

class Store : public Base {
  int secret();
 public:
  Store();
  ~Store();
  int get(int key) const;
  static Store make();
  template <typename T> T as() const;
  void inline_call() { this->get(1); detail::tick(); items.push_back(1); ptr->run(); }
 protected:
  void guard();
};

struct Options { bool verbose; void reset(); };
enum class Mode { Fast, Safe };
template <typename T> T identity(T v) { return v; }
template <typename T> class Box { T v; };
using Id = int;
constexpr int kLimit = 8;
static int counter = 0;
}

int app::Store::get(int key) const { return identity(key) + app::identity(0); }
app::Store::Store() { auto s = new Store(); }
Store& current();
`;

  it("extracts namespaces, classes, members, templates and aliases with visibility", async () => {
    const facts = await parser.parseFile({ path: "src/store.cpp", content });
    expect(facts.language).toBe("cpp");
    expect(facts.status).toBe("ok");
    expect(symbolRows(facts)).toEqual([
      { name: "c_entry", kind: "function", parent: null, exported: true },
      { name: "app", kind: "module", parent: null, exported: true },
      { name: "hidden", kind: "function", parent: "app", exported: false },
      { name: "Store", kind: "class", parent: "app", exported: true },
      { name: "secret", kind: "method", parent: "Store", exported: false },
      { name: "Store", kind: "method", parent: "Store", exported: true },
      { name: "~Store", kind: "method", parent: "Store", exported: true },
      { name: "get", kind: "method", parent: "Store", exported: true },
      { name: "make", kind: "method", parent: "Store", exported: true },
      { name: "as", kind: "method", parent: "Store", exported: true },
      { name: "inline_call", kind: "method", parent: "Store", exported: true },
      { name: "guard", kind: "method", parent: "Store", exported: false },
      { name: "Options", kind: "class", parent: "app", exported: true },
      { name: "reset", kind: "method", parent: "Options", exported: true },
      { name: "Mode", kind: "enum", parent: "app", exported: true },
      { name: "identity", kind: "function", parent: "app", exported: true },
      { name: "Box", kind: "class", parent: "app", exported: true },
      { name: "Id", kind: "type", parent: "app", exported: true },
      { name: "kLimit", kind: "constant", parent: "app", exported: true },
      { name: "counter", kind: "variable", parent: "app", exported: false },
      { name: "get", kind: "function", parent: null, exported: true },
      { name: "Store", kind: "function", parent: null, exported: true },
      { name: "current", kind: "function", parent: null, exported: true },
    ]);
  });

  it("keeps the qualifier of out-of-line definitions in the signature", async () => {
    const facts = await parser.parseFile({ path: "src/store.cpp", content });
    const outOfLine = facts.symbols.filter((s) => s.parentIndex === null && s.name === "get");
    expect(outOfLine.map((s) => s.signature)).toEqual(["int app::Store::get(int key) const"]);
  });

  it("extracts member, qualified, template and new-expression calls", async () => {
    const facts = await parser.parseFile({ path: "src/store.cpp", content });
    expect(callRows(facts)).toEqual([
      { callee: "this.get", in: "inline_call" },
      { callee: "detail::tick", in: "inline_call" },
      { callee: "items.push_back", in: "inline_call" },
      { callee: "ptr.run", in: "inline_call" },
      { callee: "identity", in: "get" },
      { callee: "app::identity", in: "get" },
      { callee: "Store", in: "Store" },
    ]);
    expect(importRows(facts)).toEqual([
      { source: "<vector>", names: [], kind: "static" },
      { source: "base.hpp", names: [], kind: "static" },
    ]);
  });
});

describe(".h language detection", () => {
  it("is path-only C by default", () => {
    expect(detectLanguage("include/a.h")).toBe("c");
    expect(parser.detectLanguage("include/a.h")).toBe("c");
  });

  it.each([
    ["class Foo { int x; };", true],
    ["namespace app { int f(); }", true],
    ["template <typename T> T id(T);", true],
    ["int Foo::get();", true],
    ['extern "C++" { int f(); }', true],
    ["struct s { int x; };\nint f(void);", false],
    ['#ifdef __cplusplus\nextern "C" {\n#endif\nint f(void);\n#ifdef __cplusplus\n}\n#endif', false],
    ["/* this class of errors */\nint f(void); // see namespace docs", false],
    ['const char *s = "a::b";', false],
    ['const char *s = "a \\" b::c";', false],
    ["/* unterminated class Foo {", false],
    ["char c = '\\'';\nnamespace app {}", true],
  ])("looksLikeCpp(%j) is %s", (content, expected) => {
    expect(looksLikeCpp(content)).toBe(expected);
  });

  it("scans adversarial headers in linear time", () => {
    const inputs = ["/*" + "a/*".repeat(50_000), '"' + '\\"'.repeat(50_000), "'" + "\\'".repeat(50_000)];
    const started = performance.now();
    for (const content of inputs) expect(looksLikeCpp(content)).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("parses a .h header as C++ when content has C++ markers", async () => {
    const content = "#pragma once\nnamespace app { class Store { public: int get(); }; }\n";
    expect(detectLanguage("include/store.h", content)).toBe("cpp");
    const facts = await parser.parseFile({ path: "include/store.h", content });
    expect(facts.language).toBe("cpp");
    expect(facts.status).toBe("ok");
    expect(symbolRows(facts)).toEqual([
      { name: "app", kind: "module", parent: null, exported: true },
      { name: "Store", kind: "class", parent: "app", exported: true },
      { name: "get", kind: "method", parent: "Store", exported: true },
    ]);
  });

  it("keeps plain C headers and explicit languages as they are", async () => {
    expect((await parser.parseFile({ path: "include/a.h", content: "int f(void);\n" })).language).toBe("c");
    expect((await parser.parseFile({ path: "include/a.h", language: "c", content: "class Foo {};\n" })).language).toBe("c");
    expect(detectLanguage("src/a.c", "class Foo {};")).toBe("c");
  });
});
