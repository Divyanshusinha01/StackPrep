/**
 * Positions are 1-based lines and 1-based columns counted in UTF-16 code units (JavaScript string
 * indexes), matching editors and LSP defaults. Range ends are exclusive.
 */
export interface Position {
  line: number;
  column: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export type ParseStatus = "ok" | "partial" | "failed" | "unsupported";

export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "variable"
  | "constant"
  | "module";

export const SYMBOL_KINDS: readonly SymbolKind[] = [
  "function", "method", "class", "interface", "type", "enum", "variable", "constant", "module",
];

export interface SymbolFact {
  name: string;
  kind: SymbolKind;
  /** Index into `symbols` of the innermost enclosing symbol, or null at top level. */
  parentIndex: number | null;
  range: Range;
  /** Declaration header text (whitespace-collapsed, truncated), without the body. */
  signature: string | null;
  exported: boolean;
}

export type ImportKind = "static" | "type" | "dynamic" | "require" | "reexport";

export interface ImportFact {
  /** Module specifier as written (quotes removed). Never resolved. */
  source: string;
  /** Imported names as written: `default` for default imports, `*` for namespace or wildcard imports. */
  names: string[];
  kind: ImportKind;
  range: Range;
}

export type ExportKind = "named" | "default" | "reexport" | "all";

export interface ExportFact {
  name: string;
  kind: ExportKind;
  /** Module specifier for re-exports, otherwise null. */
  source: string | null;
  /** Index into `symbols` when the export refers to a local declaration. */
  symbolIndex: number | null;
  range: Range;
}

export interface CallFact {
  /** Syntactic callee text as written, e.g. `this.db.from`. Not resolved to a declaration. */
  calleeText: string;
  enclosingSymbolIndex: number | null;
  range: Range;
}

export interface ParseErrorFact {
  kind: "error" | "missing";
  range: Range;
}

export type LimitName =
  | "maxBytes"
  | "maxNodes"
  | "timeout"
  | "maxSymbols"
  | "maxImports"
  | "maxExports"
  | "maxCalls"
  | "maxErrors"
  | "oversizedErrorNode";

export interface ParseStats {
  bytes: number;
  lines: number;
  nodeCount: number;
  errorCount: number;
  limitsHit: LimitName[];
}

export type FailureReason = "too_large" | "too_many_nodes" | "timeout" | "grammar_unavailable" | "no_language" | "internal_error";

export interface CodeFacts {
  language: string | null;
  status: ParseStatus;
  /** Set when status is `failed` or `unsupported`. */
  reason: FailureReason | null;
  errors: ParseErrorFact[];
  symbols: SymbolFact[];
  imports: ImportFact[];
  exports: ExportFact[];
  calls: CallFact[];
  stats: ParseStats;
}

export interface ParseLimits {
  /** UTF-8 byte cap for a single file. */
  maxBytes: number;
  /** Wall-clock budget for parsing plus querying one file. */
  timeoutMs: number;
  maxNodes: number;
  maxSymbols: number;
  maxImports: number;
  maxExports: number;
  maxCalls: number;
  maxErrors: number;
  /**
   * ERROR nodes with more children than this are excluded from queries: Tree-sitter query cost is
   * quadratic in their child count and cannot be cancelled mid-step.
   */
  maxErrorChildren: number;
}

export interface ParseFileInput {
  content: string;
  /** Language id from the registry. Detected from `path` when omitted. */
  language?: string;
  path?: string;
  limits?: Partial<ParseLimits>;
}
