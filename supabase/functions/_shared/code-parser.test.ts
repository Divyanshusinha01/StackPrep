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
