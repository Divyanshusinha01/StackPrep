import { defaultWasmLoader, GrammarCache, type WasmLoader } from "./engine.ts";
import { emptyFacts, extractFacts } from "./extract.ts";
import type { LanguageDefinition } from "./language.ts";
import { defaultLanguages } from "./languages/index.ts";
import { resolveLimits, utf8Length } from "./limits.ts";
import { createRegistry, type LanguageRegistry } from "./registry.ts";
import type { CodeFacts, ParseFileInput, ParseLimits } from "./types.ts";

export interface CodeParserOptions {
  registry?: LanguageRegistry;
  /** Resolves grammar and runtime WASM file names to bytes. Defaults to the vendored `grammars/` directory. */
  loadWasm?: WasmLoader;
  limits?: Partial<ParseLimits>;
}

export interface CodeParser {
  /** Never throws for bad source; failures are reported through `status` and `reason`. */
  parseFile(input: ParseFileInput): Promise<CodeFacts>;
  /** Path-only unless `content` is given, which lets ambiguous extensions (`.h`) pick by content. */
  detectLanguage(path: string, content?: string): string | null;
  /** Load grammars up front. Returns the load error per language id, or null when loaded. */
  preload(languageIds?: string[]): Promise<Record<string, string | null>>;
  /** Free WASM parsers and queries. The parser must not be used afterwards. */
  dispose(): void;
}

export function detectWithContent(registry: LanguageRegistry, path: string, content: string): LanguageDefinition | undefined {
  const def = registry.detect(path);
  const alternative = def?.detectContent?.(content, path);
  return (alternative ? registry.byId(alternative) : undefined) ?? def;
}

export function createCodeParser(options: CodeParserOptions = {}): CodeParser {
  const registry = options.registry ?? createRegistry(defaultLanguages);
  const cache = new GrammarCache(options.loadWasm ?? defaultWasmLoader);
  const baseLimits = resolveLimits(options.limits);

  return {
    async parseFile(input) {
      const limits = resolveLimits(baseLimits, input.limits);
      const content = input.content;
      const def = input.language !== undefined
        ? registry.byId(input.language)
        : input.path !== undefined ? detectWithContent(registry, input.path, content) : undefined;
      if (!def) return emptyFacts(input.language ?? null, "unsupported", "no_language", content);

      if (utf8Length(content) > limits.maxBytes) return emptyFacts(def.id, "failed", "too_large", content, ["maxBytes"]);

      const loaded = await cache.get(def);
      if (!loaded) return emptyFacts(def.id, "unsupported", "grammar_unavailable", content);

      try {
        return extractFacts(loaded, content, limits);
      } catch {
        return emptyFacts(def.id, "failed", "internal_error", content);
      }
    },

    detectLanguage: (path, content) =>
      (content === undefined ? registry.detect(path) : detectWithContent(registry, path, content))?.id ?? null,

    async preload(languageIds) {
      const defs = languageIds ? languageIds.map((id) => registry.byId(id) ?? id) : registry.list();
      const out: Record<string, string | null> = {};
      for (const def of defs) {
        if (typeof def === "string") {
          out[def] = "unknown language";
          continue;
        }
        out[def.id] = (await cache.get(def)) ? null : (cache.failures.get(def.id) ?? "failed to load");
      }
      return out;
    },

    dispose: () => cache.dispose(),
  };
}
