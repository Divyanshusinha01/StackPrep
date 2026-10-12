import { describe, expect, it } from "vitest";
import { createRegistry, defaultLanguages, defaultRegistry, detectLanguage, python, type LanguageDefinition } from "../src/index.ts";

const fake = (id: string, extensions: string[], filenames?: string[]): LanguageDefinition => ({
  id,
  extensions,
  filenames,
  grammar: "none.wasm",
  queries: { facts: "" },
});

describe("createRegistry", () => {
  it("registers definitions and looks them up by id and extension", () => {
    const registry = createRegistry([fake("a", [".aa", "AB"])]);
    expect(registry.byId("a")?.id).toBe("a");
    expect(registry.byExtension(".aa")?.id).toBe("a");
    expect(registry.byExtension("ab")?.id).toBe("a");
    expect(registry.byExtension(".AB")?.id).toBe("a");
    expect(registry.byId("missing")).toBeUndefined();
    expect(registry.list().map((d) => d.id)).toEqual(["a"]);
  });

  it("detects by exact filename before extension", () => {
    const registry = createRegistry([fake("make", [".mk"], ["Makefile"]), fake("txt", [".txt"])]);
    expect(registry.detect("Makefile")?.id).toBe("make");
    expect(registry.detect("dir/sub/Makefile")?.id).toBe("make");
    expect(registry.detect("dir\\sub\\notes.TXT")?.id).toBe("txt");
    expect(registry.detect("rules.mk")?.id).toBe("make");
  });

  it("uses the last extension and ignores bare dotfiles and extensionless paths", () => {
    const registry = createRegistry([fake("txt", [".txt"])]);
    expect(registry.detect("a.test.txt")?.id).toBe("txt");
    expect(registry.detect(".txt")).toBeUndefined();
    expect(registry.detect("README")).toBeUndefined();
    expect(registry.detect("archive.txt.gz")).toBeUndefined();
  });

  it("rejects duplicate ids, extensions and filenames", () => {
    const registry = createRegistry([fake("a", [".a"], ["A"])]);
    expect(() => registry.register(fake("a", [".z"]))).toThrow(/already registered/);
    expect(() => registry.register(fake("b", [".A"]))).toThrow(/extension ".a"/);
    expect(() => registry.register(fake("c", [".c"], ["A"]))).toThrow(/filename "A"/);
    expect(registry.byId("b")).toBeUndefined();
    expect(registry.byId("c")).toBeUndefined();
  });

  it("lets projects build their own language set", () => {
    const registry = createRegistry([python]);
    expect(registry.detect("main.py")?.id).toBe("python");
    expect(registry.detect("main.ts")).toBeUndefined();
  });
});

describe("default registry", () => {
  it("ships TypeScript, TSX, JavaScript, Python, Java, Go, C and C++", () => {
    expect(defaultLanguages.map((d) => d.id)).toEqual(["typescript", "tsx", "javascript", "python", "java", "go", "c", "cpp"]);
  });

  it.each([
    ["src/a.ts", "typescript"],
    ["src/a.mts", "typescript"],
    ["src/a.d.ts", "typescript"],
    ["src/A.tsx", "tsx"],
    ["src/a.js", "javascript"],
    ["src/a.jsx", "javascript"],
    ["src/a.cjs", "javascript"],
    ["src/a.mjs", "javascript"],
    ["app/main.py", "python"],
    ["types/stub.pyi", "python"],
    ["src/Main.java", "java"],
    ["cmd/main.go", "go"],
    ["src/main.c", "c"],
    ["include/lib.h", "c"],
    ["src/MAIN.C", "c"],
    ["src/a.cc", "cpp"],
    ["src/a.cpp", "cpp"],
    ["src/a.cxx", "cpp"],
    ["include/a.hpp", "cpp"],
    ["include/a.hh", "cpp"],
    ["include/a.hxx", "cpp"],
    ["include/a.ipp", "cpp"],
  ])("detects %s as %s", (path, id) => {
    expect(detectLanguage(path)).toBe(id);
    expect(defaultRegistry.detect(path)?.id).toBe(id);
  });

  it.each(["main.rs", "main.m", "README.md", "Dockerfile", "Makefile"])("does not claim %s", (path) => {
    expect(detectLanguage(path)).toBeNull();
  });
});
