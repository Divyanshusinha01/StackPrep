import { assertEquals } from "@std/assert";
import { createCodeParser, PARSER_VERSION } from "@stackprep/code-parser";

Deno.test("code-parser resolves and parses under Deno", async () => {
  const parser = createCodeParser();
  try {
    const loaded = await parser.preload();
    assertEquals(Object.values(loaded).every((error) => error === null), true, JSON.stringify(loaded));
    const facts = await parser.parseFile({ path: "svc.go", content: "package svc\n\nfunc Load() {}\n" });
    assertEquals(facts.status, "ok");
    assertEquals(facts.symbols.map((s) => [s.name, s.kind, s.exported]), [["Load", "function", true]]);
    assertEquals(typeof PARSER_VERSION, "string");
  } finally {
    parser.dispose();
  }
});

Deno.test("C and C++ grammars load under Deno and headers pick a language by content", async () => {
  const parser = createCodeParser();
  try {
    const c = await parser.parseFile({ path: "util.h", content: "#include <stdio.h>\nint add(int a, int b);\n" });
    assertEquals([c.language, c.status], ["c", "ok"]);
    assertEquals(c.symbols.map((s) => [s.name, s.kind]), [["add", "function"]]);
    const cpp = await parser.parseFile({ path: "shape.h", content: "class Shape {\npublic:\n  int area() const;\n};\n" });
    assertEquals([cpp.language, cpp.status], ["cpp", "ok"]);
    assertEquals(cpp.symbols.map((s) => [s.name, s.kind, s.exported]), [["Shape", "class", true], ["area", "method", true]]);
  } finally {
    parser.dispose();
  }
});
