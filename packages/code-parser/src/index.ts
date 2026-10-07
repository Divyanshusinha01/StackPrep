import { defaultLanguages } from "./languages/index.ts";
import { createCodeParser, type CodeParser } from "./parse-file.ts";
import { createRegistry } from "./registry.ts";
import type { CodeFacts, ParseFileInput } from "./types.ts";

export * from "./types.ts";
export type { LanguageDefinition, LanguageHooks, LanguageQueries, RawExport, SymbolContext } from "./language.ts";
export { createRegistry, type LanguageRegistry } from "./registry.ts";
export { createCodeParser, type CodeParser, type CodeParserOptions } from "./parse-file.ts";
export { defaultWasmLoader, type WasmLoader } from "./engine.ts";
export { DEFAULT_PARSE_LIMITS } from "./limits.ts";
export { defaultLanguages, go, java, javascript, python, tsx, typescript } from "./languages/index.ts";
export { GRAMMAR_VERSIONS, PARSER_VERSION } from "./version.ts";

export const defaultRegistry = createRegistry(defaultLanguages);

let shared: CodeParser | null = null;

/** Parse with a lazily created parser over `defaultRegistry`. */
export function parseFile(input: ParseFileInput): Promise<CodeFacts> {
  shared ??= createCodeParser({ registry: defaultRegistry });
  return shared.parseFile(input);
}

export function detectLanguage(path: string): string | null {
  return defaultRegistry.detect(path)?.id ?? null;
}
