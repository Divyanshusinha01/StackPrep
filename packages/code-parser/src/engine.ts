import { Language, Parser, Query } from "web-tree-sitter";
import type { LanguageDefinition } from "./language.ts";

export type WasmLoader = (file: string) => Promise<Uint8Array>;

/** Reads WASM files vendored in `grammars/` next to `src/`; works in Node and Deno. */
export const defaultWasmLoader: WasmLoader = async (file) => {
  const url = new URL(`../grammars/${file}`, import.meta.url);
  const deno = (globalThis as { Deno?: { readFile(path: URL): Promise<Uint8Array> } }).Deno;
  if (deno) return await deno.readFile(url);
  const { readFile } = await import("node:fs/promises");
  return new Uint8Array(await readFile(url));
};

// web-tree-sitter keeps one WASM runtime per JS realm.
let runtime: Promise<void> | null = null;

function initRuntime(load: WasmLoader): Promise<void> {
  runtime ??= load("web-tree-sitter.wasm")
    .then((wasmBinary) => Parser.init({ wasmBinary } as Parameters<typeof Parser.init>[0]))
    .catch((err) => {
      runtime = null;
      throw err;
    });
  return runtime;
}

export interface LoadedLanguage {
  def: LanguageDefinition;
  parser: Parser;
  query: Query;
}

/** Lazily loads grammars once per parser instance; a failed load stays failed for that instance. */
export class GrammarCache {
  private readonly entries = new Map<string, Promise<LoadedLanguage>>();
  private readonly settled = new Map<string, LoadedLanguage>();
  readonly failures = new Map<string, string>();

  private readonly loadWasm: WasmLoader;

  constructor(loadWasm: WasmLoader) {
    this.loadWasm = loadWasm;
  }

  async get(def: LanguageDefinition): Promise<LoadedLanguage | null> {
    let entry = this.entries.get(def.id);
    if (!entry) {
      entry = this.load(def);
      this.entries.set(def.id, entry);
    }
    try {
      return await entry;
    } catch (err) {
      this.failures.set(def.id, err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  private async load(def: LanguageDefinition): Promise<LoadedLanguage> {
    await initRuntime(this.loadWasm);
    const bytes = typeof def.grammar === "string" ? await this.loadWasm(def.grammar) : await def.grammar();
    const language = await Language.load(bytes);
    const parser = new Parser();
    try {
      parser.setLanguage(language);
      const query = new Query(language, def.queries.facts);
      const loaded = { def, parser, query };
      this.settled.set(def.id, loaded);
      return loaded;
    } catch (err) {
      parser.delete();
      throw err;
    }
  }

  dispose(): void {
    for (const { parser, query } of this.settled.values()) {
      query.delete();
      parser.delete();
    }
    this.settled.clear();
    this.entries.clear();
    this.failures.clear();
  }
}
