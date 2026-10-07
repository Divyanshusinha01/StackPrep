/**
 * Maps parser facts to `replace_code_index` file payloads and to the compact outline that memory
 * rows are built from. Only names, kinds, ranges and specifiers leave this module, never source.
 */
import type { CodeFacts, SymbolKind } from "@stackprep/code-parser";
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

function dirname(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/** Resolves `a/./b/../c` style segments; null when the path climbs above the repository root. */
function normalize(path: string): string | null {
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (out.length === 0) {
        return null;
      }
      out.pop();
    } else {
      out.push(segment);
    }
  }
  return out.length ? out.join("/") : null;
}

const ECMA_EXTENSIONS = ["", ".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];
const ECMA_INDEX = ["/index.ts", "/index.tsx", "/index.js", "/index.jsx", "/index.mjs"];

/**
 * Path-only guess for a relative specifier: never follows aliases, packages or configuration.
 * ECMAScript tries the usual extensions and index files (and `.js` written for a `.ts` file);
 * Python resolves leading-dot module paths. Other languages import packages, so nothing resolves.
 */
export function resolveRelativeImport(
  fromPath: string,
  language: string,
  source: string,
  knownPaths: ReadonlySet<string>,
): string | null {
  const first = (candidates: (string | null)[]) => candidates.find((c): c is string => c !== null && knownPaths.has(c)) ?? null;

  if (["typescript", "tsx", "javascript"].includes(language)) {
    if (!source.startsWith("./") && !source.startsWith("../")) {
      return null;
    }
    const base = normalize(`${dirname(fromPath)}/${source}`);
    if (!base) {
      return null;
    }
    const stem = base.replace(/\.(m|c)?jsx?$/, "");
    return first([
      ...ECMA_EXTENSIONS.map((ext) => `${base}${ext}`),
      ...(stem !== base ? [".ts", ".tsx", ".mts", ".cts"].map((ext) => `${stem}${ext}`) : []),
      ...ECMA_INDEX.map((index) => `${base}${index}`),
    ]);
  }

  if (language === "python") {
    const match = /^(\.+)([\w.]*)$/.exec(source);
    if (!match) {
      return null;
    }
    let dir = dirname(fromPath);
    for (let i = 1; i < match[1].length; i++) {
      if (!dir) {
        return null;
      }
      dir = dirname(dir);
    }
    const rest = match[2] ? match[2].split(".").join("/") : "";
    const base = [dir, rest].filter(Boolean).join("/");
    return base ? first([`${base}.py`, `${base}.pyi`, `${base}/__init__.py`]) : null;
  }

  return null;
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
    .map((imp) => ({
      source: imp.source,
      kind: imp.kind,
      names: imp.names.slice(0, MAX_IMPORT_NAMES),
      resolved_path: resolveRelativeImport(file.path, language, imp.source, knownPaths),
      line: imp.range.start.line,
    }));

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
