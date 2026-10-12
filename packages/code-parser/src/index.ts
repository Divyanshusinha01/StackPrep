import { defaultLanguages } from "./languages/index.ts";
import { createCodeParser, detectWithContent, type CodeParser } from "./parse-file.ts";
import { createRegistry } from "./registry.ts";
import type { CodeFacts, ParseFileInput } from "./types.ts";

export * from "./types.ts";
export type { LanguageDefinition, LanguageHooks, LanguageQueries, RawExport, SymbolContext } from "./language.ts";
export { createRegistry, type LanguageRegistry } from "./registry.ts";
export { createCodeParser, type CodeParser, type CodeParserOptions } from "./parse-file.ts";
export { defaultWasmLoader, type WasmLoader } from "./engine.ts";
export { DEFAULT_PARSE_LIMITS } from "./limits.ts";
export { c, cpp, defaultLanguages, go, java, javascript, python, tsx, typescript } from "./languages/index.ts";
export { looksLikeCpp } from "./languages/c-family.ts";
export { GRAMMAR_VERSIONS, PARSER_VERSION } from "./version.ts";
export * from "./resolve/index.ts";

export const defaultRegistry = createRegistry(defaultLanguages);

let shared: CodeParser | null = null;

/** Parse with a lazily created parser over `defaultRegistry`. */
export function parseFile(input: ParseFileInput): Promise<CodeFacts> {
  shared ??= createCodeParser({ registry: defaultRegistry });
  return shared.parseFile(input);
}

/** Path-only by default (`.h` is C); pass `content` to let a `.h` header select C++. */
export function detectLanguage(path: string, content?: string): string | null {
  return (content === undefined ? defaultRegistry.detect(path) : detectWithContent(defaultRegistry, path, content))?.id ?? null;
}
