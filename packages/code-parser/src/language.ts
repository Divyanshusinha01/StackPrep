import type { Node } from "web-tree-sitter";
import type { ExportKind, ImportKind, SymbolKind } from "./types.ts";

/**
 * Query capture conventions (one combined query per language):
 * - `@definition.<kind>` on a declaration node plus `@name` on its name node (or no `@name` when
 *   `hooks.definitions` names it).
 * - `@import` on an import node plus `@import.source` on the module specifier; `(#set! kind "...")` sets ImportKind.
 * - `@export` on an export statement (passed to `hooks.collectExports`).
 * - `@call` on a call node plus `@call.callee` (and optional `@call.object`).
 * Captures starting with `_` are helpers for predicates and are ignored.
 */
export interface LanguageQueries {
  facts: string;
}

export interface SymbolContext {
  name: string;
  kind: SymbolKind;
  parent: { kind: SymbolKind; exported: boolean } | null;
}

export interface RawExport {
  name: string;
  kind: ExportKind;
  source: string | null;
  /** Local declaration name this export refers to, used to link and mark the symbol as exported. */
  localName: string | null;
  node: Node;
}

export interface LanguageHooks {
  /**
   * Names a `@definition.<kind>` captured without `@name` (one entry per declared name, before
   * parent linking). An empty result drops the definition. Lets grammars with deeply nested
   * declarators (C/C++) stay a handful of query patterns, which keeps query compilation fast.
   */
  definitions?(def: Node, kind: SymbolKind): { name: Node; kind: SymbolKind }[];
  refineKind?(def: Node, kind: SymbolKind): SymbolKind;
  /** Export classification for a declaration, or null when not visible outside its module. */
  exportOf?(def: Node, ctx: SymbolContext): Extract<ExportKind, "named" | "default"> | null;
  importDetails?(node: Node, source: string): { names: string[]; kind?: ImportKind };
  collectExports?(node: Node): RawExport[];
}

export interface LanguageDefinition {
  id: string;
  /** Lowercase extensions including the dot, e.g. `.ts`. */
  extensions: readonly string[];
  /** Exact basenames that select this language regardless of extension. */
  filenames?: readonly string[];
  /** Grammar WASM file name resolved by the parser's loader, or a custom byte loader. */
  grammar: string | (() => Promise<Uint8Array>);
  queries: LanguageQueries;
  hooks?: LanguageHooks;
  /**
   * Content-aware override for path-detected files with an ambiguous extension (e.g. `.h`): the id
   * of the language to parse with instead, or null to keep this one. Never consulted when the caller
   * names a language explicitly.
   */
  detectContent?(content: string, path: string): string | null;
}
