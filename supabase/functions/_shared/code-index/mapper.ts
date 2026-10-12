/**
 * Maps parser facts to `replace_code_index` file payloads and to the compact outline that memory
 * rows are built from. Only names, kinds, ranges and specifiers leave this module, never source.
 */
import { type CodeFacts, type ImportResolution, resolveImport, type SymbolKind } from "@stackprep/code-parser";
import type { CodeIndexFile } from "./select.ts";

/** Call sites kept per file; the rest are counted in `stats.calls_dropped`. */
export const MAX_CALLS_PER_FILE = 500;
const MAX_NAME_CHARS = 512;
const MAX_SIGNATURE_CHARS = 512;
const MAX_SOURCE_CHARS = 1024;
const MAX_CALLEE_CHARS = 256;
const MAX_IMPORT_NAMES = 500;
const OUTLINE_SYMBOLS = 40;
const OUTLINE_IMPORTS = 30;

export type CodeFileStatus = "ok" | "partial" | "failed" | "unsupported" | "skipped";

/** Why a file has no facts before parsing was attempted. */
export type CodeFileSkipReason = "too_large" | "not_utf8" | "secret" | "fetch_failed";

export interface CodeSymbolPayload {
  name: string;
  kind: SymbolKind;
  parent_ord: number | null;
  start_line: number;
  start_col: number;
  end_line: number;
  end_col: number;
  exported: boolean;
  signature: string | null;
}

export interface CodeImportPayload {
  source: string;
  kind: string;
  names: string[];
  resolved_path: string | null;
  resolution: ImportResolution | null;
  line: number;
}

export interface CodeCallPayload {
  caller_ord: number | null;
  callee_text: string;
  line: number;
  col: number;
}

/** One element of `replace_code_index`'s `p_files`. */
export interface CodeFilePayload {
  path: string;
  blob_sha: string;
  language: string | null;
  size_bytes: number;
  line_count: number | null;
  parse_status: CodeFileStatus;
  parse_error_count: number;
  skipped_reason: string | null;
  stats: Record<string, unknown>;
  symbols: CodeSymbolPayload[];
  imports: CodeImportPayload[];
  calls: CodeCallPayload[];
}

export interface OutlineSymbol {
  name: string;
  kind: SymbolKind;
  parent: string | null;
  start_line: number;
  end_line: number;
  exported: boolean;
}

/** What memory rows are built from; kept small because it is a durable step output. */
export interface FileOutline {
  path: string;
  language: string;
  lines: number;
  symbols: OutlineSymbol[];
  /** Total symbols in the file, before the outline cap. */
  symbol_count: number;
  imports: { source: string; resolved_path: string | null }[];
}

const LANGUAGE_ID = /^[a-z][a-z0-9_-]{0,31}$/;

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

/** Path-only resolution through the shared resolver; see `resolveImport` in the parser package. */
function resolveImportPayload(
  fromPath: string,
  language: string | null,
  source: string,
  names: readonly string[],
  knownPaths: ReadonlySet<string>,
): Pick<CodeImportPayload, "resolved_path" | "resolution"> {
  const target = resolveImport(fromPath, language, source, knownPaths, names);
  return { resolved_path: target.resolvedPath, resolution: target.resolution };
}

/** The resolved repository path of one import, or null; directory targets end in `/`. */
export function resolveRelativeImport(
  fromPath: string,
  language: string,
  source: string,
  knownPaths: ReadonlySet<string>,
  names: readonly string[] = [],
): string | null {
  return resolveImport(fromPath, language, source, knownPaths, names).resolvedPath;
}

function emptyPayload(file: Pick<CodeIndexFile, "path" | "sha" | "size">): Omit<CodeFilePayload, "parse_status" | "skipped_reason"> {
  return {
    path: file.path,
    blob_sha: file.sha,
    language: null,
    size_bytes: file.size,
    line_count: null,
    parse_error_count: 0,
    stats: {},
    symbols: [],
    imports: [],
    calls: [],
  };
}

export function skippedPayload(file: CodeIndexFile, reason: CodeFileSkipReason): CodeFilePayload {
  return {
    ...emptyPayload(file),
    language: LANGUAGE_ID.test(file.language) ? file.language : null,
    parse_status: "skipped",
    skipped_reason: reason,
  };
}

export function failedPayload(file: CodeIndexFile, sizeBytes: number, reason: string): CodeFilePayload {
  return { ...skippedPayload(file, "too_large"), size_bytes: sizeBytes, parse_status: "failed", skipped_reason: reason };
}

/** Same input always yields the same payload, so `replace_code_index` can skip unchanged files. */
export function toFilePayload(
  file: CodeIndexFile,
  facts: CodeFacts,
  sizeBytes: number,
  knownPaths: ReadonlySet<string>,
): CodeFilePayload {
  const language = facts.language && LANGUAGE_ID.test(facts.language) ? facts.language : null;
  const parsed = (facts.status === "ok" || facts.status === "partial") && language !== null;
  const base = { ...emptyPayload(file), size_bytes: sizeBytes, language, line_count: facts.stats.lines };
  if (!parsed) {
    return {
      ...base,
      parse_status: facts.status === "partial" || facts.status === "ok" ? "failed" : facts.status,
      skipped_reason: facts.reason ?? "internal_error",
      stats: { limits_hit: facts.stats.limitsHit },
    };
  }

  const symbols: CodeSymbolPayload[] = facts.symbols.map((s, i) => {
    const endBeforeStart = s.range.end.line < s.range.start.line ||
      (s.range.end.line === s.range.start.line && s.range.end.column < s.range.start.column);
    return {
      name: clip(s.name, MAX_NAME_CHARS),
      kind: s.kind,
      parent_ord: s.parentIndex !== null && s.parentIndex >= 0 && s.parentIndex < i ? s.parentIndex : null,
      start_line: s.range.start.line,
      start_col: s.range.start.column,
      end_line: endBeforeStart ? s.range.start.line : s.range.end.line,
      end_col: endBeforeStart ? s.range.start.column : s.range.end.column,
      exported: s.exported,
      signature: s.signature ? clip(s.signature, MAX_SIGNATURE_CHARS) : null,
    };
  }).filter((s) => s.name.length > 0);
  // Dropping an empty name would shift ordinals; the parser never emits one, so bail out instead.
  if (symbols.length !== facts.symbols.length) {
    return { ...base, parse_status: "failed", skipped_reason: "internal_error", stats: {} };
  }

  const imports: CodeImportPayload[] = facts.imports
    .filter((imp) => imp.source.length > 0 && imp.source.length <= MAX_SOURCE_CHARS)
    .map((imp) => {
      const names = imp.names.slice(0, MAX_IMPORT_NAMES);
      return {
        source: imp.source,
        kind: imp.kind,
        names,
        ...resolveImportPayload(file.path, language, imp.source, names, knownPaths),
        line: imp.range.start.line,
      };
    });

  const eligibleCalls = facts.calls.filter((c) => c.calleeText.length > 0 && c.calleeText.length <= MAX_CALLEE_CHARS);
  const calls: CodeCallPayload[] = eligibleCalls.slice(0, MAX_CALLS_PER_FILE).map((c) => ({
    caller_ord: c.enclosingSymbolIndex !== null && c.enclosingSymbolIndex >= 0 && c.enclosingSymbolIndex < symbols.length
      ? c.enclosingSymbolIndex
      : null,
    callee_text: c.calleeText,
    line: c.range.start.line,
    col: c.range.start.column,
  }));

  return {
    ...base,
    parse_status: facts.status as "ok" | "partial",
    parse_error_count: facts.stats.errorCount,
    skipped_reason: null,
    stats: {
      node_count: facts.stats.nodeCount,
      limits_hit: facts.stats.limitsHit,
      exports: facts.exports.length,
      calls_dropped: facts.calls.length - calls.length,
    },
    symbols,
    imports,
    calls,
  };
}

/**
 * Rebuilds a payload stored for the same path, blob and parser version at another commit. Only
 * `resolved_path` and `resolution` depend on the rest of the tree, so they are recomputed against
 * the new commit's paths; the result equals a fresh parse of the same blob in the same tree.
 */
export function hydratePayload(stored: CodeFilePayload, knownPaths: ReadonlySet<string>): CodeFilePayload {
  const language = stored.language;
  return {
    path: stored.path,
    blob_sha: stored.blob_sha,
    language,
    size_bytes: stored.size_bytes,
    line_count: stored.line_count,
    parse_status: stored.parse_status,
    parse_error_count: stored.parse_error_count,
    skipped_reason: stored.skipped_reason,
    stats: stored.stats,
    symbols: stored.symbols.map((s) => ({ ...s })),
    imports: stored.imports.map((imp) => ({
      source: imp.source,
      kind: imp.kind,
      names: [...imp.names],
      ...(language
        ? resolveImportPayload(stored.path, language, imp.source, imp.names, knownPaths)
        : { resolved_path: null, resolution: null }),
      line: imp.line,
    })),
    calls: stored.calls.map((c) => ({ ...c })),
  };
}

/** Exported top-level symbols first, then other top-level ones, then members; source order within. */
export function toOutline(payload: CodeFilePayload): FileOutline | null {
  if ((payload.parse_status !== "ok" && payload.parse_status !== "partial") || !payload.language) {
    return null;
  }
  const rank = (s: CodeSymbolPayload) => (s.parent_ord === null ? (s.exported ? 0 : 1) : 2);
  const symbols = payload.symbols
    .map((s, ord) => ({ s, ord }))
    .sort((a, b) => rank(a.s) - rank(b.s) || a.ord - b.ord)
    .slice(0, OUTLINE_SYMBOLS)
    .sort((a, b) => a.ord - b.ord)
    .map(({ s }) => ({
      name: s.name.slice(0, 120),
      kind: s.kind,
      parent: s.parent_ord === null ? null : payload.symbols[s.parent_ord].name.slice(0, 120),
      start_line: s.start_line,
      end_line: s.end_line,
      exported: s.exported,
    }));
  const seen = new Set<string>();
  const imports = payload.imports
    .filter((imp) => !seen.has(imp.source) && seen.add(imp.source))
    .slice(0, OUTLINE_IMPORTS)
    .map((imp) => ({ source: imp.source.slice(0, 200), resolved_path: imp.resolved_path }));
  return {
    path: payload.path,
    language: payload.language,
    lines: payload.line_count ?? 0,
    symbols,
    symbol_count: payload.symbols.length,
    imports,
  };
}
