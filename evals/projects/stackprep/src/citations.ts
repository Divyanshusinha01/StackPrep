/**
 * Citation extraction and resolution against a pinned corpus. A citation is a repository path (file or
 * module directory), optionally with a line range or symbol, or a code identifier on its own. Validity
 * asks only whether the cited thing exists at the pinned commit; whether it supports a claim is the
 * support suite's question.
 *
 * What counts as a citation in free text:
 * - backticked spans that look like a path or an identifier (`src/a.ts`, `OrderService.createOrder()`);
 * - path tokens: slash paths whose last segment has a file extension or whose first segment is a
 *   top-level corpus directory, and bare file names with a known extension; with `:12`, `:12-30`,
 *   `#L12-L30`, a following `(symbol, lines 12-30)` or `lines 12-30`;
 * - identifiers in prose that are unmistakably code: `name()`, `Pascal.member`, camelCase,
 *   SCREAMING_SNAKE and snake_case words.
 * Plain words, technology names (Node.js) and URLs are not citations.
 */
import type { IndexedCorpus } from "./corpus.ts";

export interface Citation {
  /** As written, for reports. */
  raw: string;
  /** Repository path as cited, normalized (no leading "./", no trailing punctuation). */
  path?: string;
  /** Identifier as cited, e.g. "OrderService.createOrder"; "()" removed. */
  symbol?: string;
  lines?: [number, number];
}

export interface Resolution {
  valid: boolean;
  /** Per-part outcome; absent parts were not cited. */
  checks: { path?: boolean; lines?: boolean; symbol?: boolean };
  /** Why it is invalid. */
  reason?: string;
  /** The file the citation lands in, when it lands in one. */
  file?: string;
  /** The path names a directory (module), which has no span. */
  module?: boolean;
  /** Line range of the cited symbol in `file`, when the code index has it. */
  symbolLines?: [number, number];
}

export interface Span {
  path: string;
  start: number;
  end: number;
  /** The lines start..end joined with "\n". */
  text: string;
  /** The span was cut at MAX_SPAN_LINES. */
  truncated: boolean;
}

/** Longest span handed to anchors and the judge; whole-file citations beyond it are cut. */
export const MAX_SPAN_LINES = 300;

const KNOWN_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "py", "go", "java", "kt", "rb", "rs", "c", "h", "cc", "cpp",
  "hpp", "cs", "php", "swift", "scala", "sql", "json", "md", "yml", "yaml", "toml", "sh", "css", "scss", "html",
  "vue", "svelte", "lock", "env", "txt", "xml", "gradle", "proto",
]);
/** Technology names that look like file names. */
const TECHNOLOGY_NAMES = new Set([
  "node.js", "next.js", "nuxt.js", "vue.js", "express.js", "three.js", "d3.js", "chart.js", "socket.io", "react.js",
  "nest.js", "ember.js", "backbone.js", "deno.json",
]);

const BACKTICK = /`([^`\n]{1,200})`/g;
/** Path-like token; the lookbehind keeps it from starting inside a word, a URL or another path. */
const PATH_TOKEN = /(?<![A-Za-z0-9_@.\/:\\-])((?:\.\/)?[A-Za-z0-9_@][A-Za-z0-9_@.-]*(?:\/[A-Za-z0-9_@.-]+)*\/?)(:\d+(?:\s*[-–]\s*\d+)?|#L\d+(?:-L?\d+)?)?/g;
const IDENT_TEXT = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\(\))?$/;
/** A sentence may end right after an identifier; a dot followed by a word character continues it. */
const IDENT_END = String.raw`(?![\w$\/(-]|\.[\w$])`;
const PROSE_IDENTIFIERS: RegExp[] = [
  /(?<![\w$.\/])([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\(\)/g,
  new RegExp(String.raw`(?<![\w$.\/])([A-Z][A-Za-z0-9_$]+\.[A-Za-z_$][\w$]*)${IDENT_END}`, "g"),
  new RegExp(String.raw`(?<![\w$.\/-])([a-z][a-z0-9]*[A-Z][A-Za-z0-9]*)${IDENT_END}`, "g"),
  new RegExp(String.raw`(?<![\w$.\/-])([A-Z][A-Z0-9]*_[A-Z0-9_]*[A-Z0-9])${IDENT_END}`, "g"),
  new RegExp(String.raw`(?<![\w$.\/-])([a-z][a-z0-9]*_[a-z0-9_]*[a-z0-9])${IDENT_END}`, "g"),
];
/** Brand names shaped like camelCase identifiers. */
const NOT_IDENTIFIERS = new Set(["iOS", "macOS", "iPhone", "iPad", "eBay", "gRPC", "jQuery", "iCloud", "watchOS", "tvOS"]);
const TRAILING_PUNCTUATION = /[.,;:!?'")\]]+$/;
const PAREN_DETAIL = /^\s*\(([^()\n]{1,160})\)/;
const LINES_AFTER = /^,?\s*(?:at\s+|on\s+)?lines?\s+(\d+)(?:\s*(?:[-–]|to)\s*(\d+))?/i;
const LINES_TEXT = /^lines?\s+(\d+)(?:\s*(?:[-–]|to)\s*(\d+))?$/i;

function extensionOf(segment: string): string | undefined {
  const dot = segment.lastIndexOf(".");
  return dot > 0 && dot < segment.length - 1 ? segment.slice(dot + 1).toLowerCase() : undefined;
}

function topLevelDirs(paths: Iterable<string>): Set<string> {
  const dirs = new Set<string>();
  for (const path of paths) {
    const slash = path.indexOf("/");
    if (slash > 0) dirs.add(path.slice(0, slash));
  }
  return dirs;
}

/** Whether a token is a path citation rather than prose ("and/or", "Node.js", "e.g"). */
function isPathLike(token: string, topDirs: ReadonlySet<string>): boolean {
  if (TECHNOLOGY_NAMES.has(token.toLowerCase())) return false;
  const segments = token.replace(/\/$/, "").split("/");
  const ext = extensionOf(segments.at(-1)!);
  if (segments.length === 1) {
    return ext !== undefined && KNOWN_EXTENSIONS.has(ext) && /[A-Za-z]/.test(segments[0].slice(0, -ext.length - 1));
  }
  return (ext !== undefined && KNOWN_EXTENSIONS.has(ext)) || topDirs.has(segments[0]);
}

function parseLineSuffix(suffix: string | undefined): [number, number] | undefined {
  if (!suffix) return undefined;
  const nums = suffix.match(/\d+/g)!.map(Number);
  return [nums[0], nums[1] ?? nums[0]];
}

/** "(symbol, lines 3-9)", "(lines 3-9)" or "(symbol)" directly after a path. */
function parseDetail(inner: string): { symbol?: string; lines?: [number, number] } | undefined {
  const out: { symbol?: string; lines?: [number, number] } = {};
  for (const part of inner.split(",").map((p) => p.trim()).filter(Boolean)) {
    const lines = part.match(LINES_TEXT);
    if (lines) {
      out.lines = [Number(lines[1]), Number(lines[2] ?? lines[1])];
    } else if (IDENT_TEXT.test(part.replace(/^`|`$/g, "")) && !out.symbol) {
      out.symbol = part.replace(/^`|`$/g, "").replace(/\(\)$/, "");
    } else {
      return undefined;
    }
  }
  return out.symbol || out.lines ? out : undefined;
}

function normalizePath(token: string): string {
  return token.replace(/^\.\//, "").replace(TRAILING_PUNCTUATION, "");
}

/** Path citation from a token and the text right after it. Returns the citation and how much text it used. */
function pathCitation(token: string, suffix: string | undefined, after: string): { citation: Citation; consumed: number } {
  const path = normalizePath(token);
  const citation: Citation = { raw: token + (suffix ?? ""), path };
  const lines = parseLineSuffix(suffix);
  if (lines) citation.lines = lines;
  let consumed = 0;
  if (!lines) {
    const paren = after.match(PAREN_DETAIL);
    const detail = paren ? parseDetail(paren[1]) : undefined;
    if (paren && detail) {
      Object.assign(citation, detail);
      citation.raw += paren[0];
      consumed = paren[0].length;
    } else {
      const range = after.match(LINES_AFTER);
      if (range) {
        citation.lines = [Number(range[1]), Number(range[2] ?? range[1])];
        citation.raw += range[0];
        consumed = range[0].length;
      }
    }
  }
  return { citation, consumed };
}

/** Citations in `text`, in order of appearance. `paths` is the corpus file list, used to recognize module paths. */
export function extractCitations(text: string, paths: Iterable<string>): Citation[] {
  const topDirs = topLevelDirs(paths);
  const found: Array<{ at: number; citation: Citation }> = [];
  const masked = text.split("");
  const mask = (start: number, end: number) => {
    for (let i = start; i < end; i++) masked[i] = " ";
  };

  for (const m of text.matchAll(BACKTICK)) {
    const inner = m[1].trim();
    const start = m.index!;
    const pathMatch = inner.match(/^((?:\.\/)?[A-Za-z0-9_@][A-Za-z0-9_@.\/-]*?)(:\d+(?:\s*[-–]\s*\d+)?|#L\d+(?:-L?\d+)?)?$/);
    let end = start + m[0].length;
    if (pathMatch && isPathLike(pathMatch[1], topDirs)) {
      const { citation, consumed } = pathCitation(pathMatch[1], pathMatch[2], text.slice(end));
      found.push({ at: start, citation: { ...citation, raw: `\`${inner}\`${citation.raw.slice(pathMatch[0].length)}` } });
      end += consumed;
    } else if (IDENT_TEXT.test(inner)) {
      found.push({ at: start, citation: { raw: m[0], symbol: inner.replace(/\(\)$/, "") } });
    }
    mask(start, end);
  }

  let rest = masked.join("");
  for (const m of rest.matchAll(PATH_TOKEN)) {
    const token = m[1].replace(TRAILING_PUNCTUATION, "");
    if (!isPathLike(token, topDirs)) continue;
    const start = m.index!;
    const suffix = m[1].length === token.length ? m[2] : undefined;
    const tokenEnd = start + token.length + (suffix?.length ?? 0);
    const { citation, consumed } = pathCitation(token, suffix, rest.slice(tokenEnd));
    found.push({ at: start, citation });
    mask(start, tokenEnd + consumed);
  }

  rest = masked.join("");
  for (const pattern of PROSE_IDENTIFIERS) {
    for (const m of rest.matchAll(pattern)) {
      const name = m[1];
      const start = m.index!;
      const leaf = name.split(".").at(-1)!;
      if (NOT_IDENTIFIERS.has(name) || (name.includes(".") && KNOWN_EXTENSIONS.has(leaf.toLowerCase()))) continue;
      found.push({ at: start, citation: { raw: m[0], symbol: name } });
      mask(start, start + m[0].length);
    }
    rest = masked.join("");
  }

  return found.sort((a, b) => a.at - b.at).map((f) => f.citation);
}

/** A field whose whole value is meant to be a repository path (`repository_evidence[].path`). */
export function strictPathCitation(text: string): Citation {
  const trimmed = text.trim();
  const m = trimmed.match(/^(.*?)(:\d+(?:\s*[-–]\s*\d+)?|#L\d+(?:-L?\d+)?)?$/)!;
  const { citation } = pathCitation(m[1], m[2], "");
  return { ...citation, raw: trimmed };
}

export function lineCount(text: string): number {
  if (text.length === 0) return 0;
  const lines = text.split("\n").length;
  return text.endsWith("\n") ? lines - 1 : lines;
}

function wordPattern(word: string): RegExp {
  return new RegExp(`(?<![\\w$])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w$])`);
}

/** Where a symbol lives: the code index first, then a whole-word occurrence of every part in the text. */
function resolveSymbol(
  corpus: IndexedCorpus,
  symbol: string,
  file: string | undefined,
): { file: string; lines?: [number, number] } | undefined {
  const parts = symbol.split(".");
  const leaf = parts.at(-1)!;
  const parent = parts.length > 1 ? parts.at(-2)! : undefined;
  const indexed = corpus.symbols
    .filter((s) => s.name === leaf && (!file || s.path === file))
    .filter((s) =>
      !parent || s.parent_name === parent ||
      (s.parent_name === null && corpus.symbols.some((t) => t.path === s.path && t.name === parent))
    )
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.start_line - b.start_line));
  if (indexed.length > 0) return { file: indexed[0].path, lines: [indexed[0].start_line, indexed[0].end_line] };
  const patterns = parts.map(wordPattern);
  const files = file ? [file] : [...corpus.files.keys()];
  const hit = files.find((path) => patterns.every((p) => p.test(corpus.files.get(path) ?? "")));
  return hit ? { file: hit } : undefined;
}

/** Resolves a citation against the pinned corpus. */
export function resolveCitation(corpus: IndexedCorpus, citation: Citation): Resolution {
  const checks: Resolution["checks"] = {};
  const fail = (reason: string, extra: Partial<Resolution> = {}): Resolution => ({ valid: false, checks, reason, ...extra });
  let file: string | undefined;
  let module = false;

  if (citation.path !== undefined) {
    const path = citation.path.replace(/\/$/, "");
    if (!citation.path.endsWith("/") && corpus.files.has(path)) {
      file = path;
    } else if (path && [...corpus.files.keys()].some((p) => p.startsWith(`${path}/`))) {
      module = true;
    } else if (!path.includes("/")) {
      file = [...corpus.files.keys()].find((p) => p.endsWith(`/${path}`));
    }
    checks.path = file !== undefined || module;
    if (!checks.path) return fail(`no file or directory "${citation.path}"`);
  }

  if (citation.lines) {
    const [start, end] = citation.lines;
    if (!file) {
      checks.lines = false;
      return fail("a line range needs a file, not a directory", { module });
    }
    checks.lines = start >= 1 && start <= end && end <= lineCount(corpus.files.get(file)!);
    if (!checks.lines) return fail(`lines ${start}-${end} are outside ${file} (${lineCount(corpus.files.get(file)!)} lines)`, { file });
  }

  let symbolLines: [number, number] | undefined;
  if (citation.symbol !== undefined) {
    const found = module ? undefined : resolveSymbol(corpus, citation.symbol, file);
    checks.symbol = found !== undefined;
    if (!found) return fail(`no symbol "${citation.symbol}"${file ? ` in ${file}` : module ? " (cited with a directory)" : ""}`, { file, module });
    file = found.file;
    symbolLines = found.lines;
  }

  return {
    valid: true,
    checks,
    ...(file ? { file } : {}),
    ...(module ? { module } : {}),
    ...(symbolLines ? { symbolLines } : {}),
  };
}

/**
 * The code a valid, file-level citation points at: its line range, else its symbol's lines, else the
 * whole file, cut at MAX_SPAN_LINES. Null for invalid or module-level citations.
 */
export function citationSpan(corpus: IndexedCorpus, citation: Citation, resolution: Resolution): Span | null {
  if (!resolution.valid || !resolution.file) return null;
  const text = corpus.files.get(resolution.file)!;
  const lines = text.split("\n");
  const total = lineCount(text);
  const [start, end] = citation.lines ?? resolution.symbolLines ?? [1, Math.max(total, 1)];
  const cut = Math.min(end, start + MAX_SPAN_LINES - 1);
  return { path: resolution.file, start, end: cut, text: lines.slice(start - 1, cut).join("\n"), truncated: cut < end };
}

export interface Anchor {
  /** JavaScript regular expression source. */
  pattern: string;
  flags?: string;
  /** True: the span must match. False: the span must not match (absence anchors, e.g. a missing guard). */
  present: boolean;
  note?: string;
}

/** Whether every anchor holds on the span text. */
export function anchorsHold(anchors: readonly Anchor[], text: string): boolean {
  return anchors.every((a) => new RegExp(a.pattern, a.flags ?? "").test(text) === a.present);
}

/** Problems with anchor definitions (bad regex, unsupported flags); empty when they are usable. */
export function anchorProblems(anchors: readonly Anchor[]): string[] {
  const problems: string[] = [];
  for (const a of anchors) {
    if (typeof a.pattern !== "string" || a.pattern.length === 0) problems.push("anchor without a pattern");
    else if (typeof a.present !== "boolean") problems.push(`anchor /${a.pattern}/ needs present: true or false`);
    else if (a.flags !== undefined && !/^[ims]*$/.test(a.flags)) problems.push(`anchor /${a.pattern}/ has unsupported flags "${a.flags}"`);
    else {
      try {
        new RegExp(a.pattern, a.flags ?? "");
      } catch (err) {
        problems.push(`anchor /${a.pattern}/: ${(err as Error).message}`);
      }
    }
  }
  return problems;
}
