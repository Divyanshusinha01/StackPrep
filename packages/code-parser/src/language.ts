import type { Node } from "web-tree-sitter";
import type { ExportKind, ImportKind, SymbolKind } from "./types.ts";

/**
 * Query capture conventions (one combined query per language):
 * - `@definition.<kind>` on a declaration node plus `@name` on its name node.
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
}
