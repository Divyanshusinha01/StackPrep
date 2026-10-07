/**
 * Prose memory rows derived from code index outlines, embedded by the existing memory pipeline:
 * one `code_module` row per directory and one symbol-outline `file_summary` row for each of the
 * most relevant files. Facts are syntactic (names and ranges as written), never resolved.
 */
import { fitStructured } from "../analysis/context.ts";
import { scrubDeep, scrubSecrets } from "../analysis/scrub.ts";
import type { FileOutline, OutlineSymbol } from "./mapper.ts";

export const CODE_MEMORY_LIMITS = {
  /** Keeps code rows plus baseline rows under the 200 rows search_repository loads per commit. */
  maxModules: 60,
  maxFileSummaries: 40,
  maxContentChars: 2_000,
  maxStructuredBytes: 8_192,
  moduleExports: 15,
  moduleLinks: 15,
} as const;

/**
 * Kinds that readers loading commit summaries skip: per-file rows and the code index's own rows
 * (metadata-only `code_index`, per-directory `code_module`).
 */
export const NON_SUMMARY_KIND_LIST: readonly string[] = ["file_summary", "code_index", "code_module"];
/** The same kinds as a PostgREST `in` list. */
export const NON_SUMMARY_KINDS = `(${NON_SUMMARY_KIND_LIST.join(",")})`;

export type CodeMemoryKind = "code_module" | "file_summary";

/** One element of `save_code_memory`'s `p_rows`. */
export interface CodeMemoryRow {
  kind: CodeMemoryKind;
  content: string;
  structured: Record<string, unknown> & { path: string };
  metadata: Record<string, unknown>;
  token_count: number;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function dirname(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Directory key as shown to the model: `src/auth/`, or `./` for the repository root. */
function moduleKey(path: string): string {
  const dir = dirname(path);
  return dir ? `${dir}/` : "./";
}

function lines(s: OutlineSymbol): string {
  return s.start_line === s.end_line ? `line ${s.start_line}` : `lines ${s.start_line}-${s.end_line}`;
}

function qualified(s: OutlineSymbol): string {
  return s.parent ? `${s.parent}.${s.name}` : s.name;
}

function row(kind: CodeMemoryKind, content: string, structured: CodeMemoryRow["structured"], metadata: Record<string, unknown>): CodeMemoryRow {
  const text = clip(scrubSecrets(content), CODE_MEMORY_LIMITS.maxContentChars);
  const fitted = fitStructured(scrubDeep(structured), CODE_MEMORY_LIMITS.maxStructuredBytes);
  return {
    kind,
    content: text,
    structured: { ...fitted, path: structured.path },
    metadata,
    token_count: Math.ceil(text.length / 4),
  };
}

export function fileSummaryRow(outline: FileOutline, metadata: Record<string, unknown>): CodeMemoryRow {
  const symbols = outline.symbols.map((s) => `${s.exported ? "exported " : ""}${s.kind} ${qualified(s)} (${lines(s)})`);
  const more = outline.symbol_count - outline.symbols.length;
  const imports = outline.imports.map((i) => (i.resolved_path ? `${i.source} (${i.resolved_path})` : i.source));
  const content = [
    `${outline.path} (${outline.language}, ${outline.lines} lines)`,
    symbols.length ? `Symbols: ${symbols.join("; ")}${more > 0 ? `; and ${more} more` : ""}` : "No declarations found.",
    imports.length ? `Imports: ${imports.join(", ")}` : null,
  ].filter(Boolean).join("\n");
  return row("file_summary", content, {
    path: outline.path,
    language: outline.language,
    lines: outline.lines,
    symbols: outline.symbols,
    imports: outline.imports,
  }, metadata);
}

interface ModuleAcc {
  key: string;
  files: FileOutline[];
}

export function codeModuleRow(module: ModuleAcc, metadata: Record<string, unknown>): CodeMemoryRow {
  const L = CODE_MEMORY_LIMITS;
  const languages = [...new Set(module.files.map((f) => f.language))].sort();
  const exports = module.files
    .flatMap((f) => f.symbols.filter((s) => s.exported && s.parent === null).map((s) => ({ ...s, file: basename(f.path), path: f.path })))
    .slice(0, L.moduleExports);
  const dependsOn = new Set<string>();
  const external = new Set<string>();
  for (const file of module.files) {
    for (const imp of file.imports) {
      if (imp.resolved_path) {
        const target = moduleKey(imp.resolved_path);
        if (target !== module.key) {
          dependsOn.add(target);
        }
      } else if (!imp.source.startsWith(".")) {
        external.add(imp.source);
      }
    }
  }
  const depends = [...dependsOn].sort().slice(0, L.moduleLinks);
  const externals = [...external].sort().slice(0, L.moduleLinks);
  const names = module.files.map((f) => basename(f.path));

  const content = [
    `Module ${module.key} (${languages.join(", ")}; ${module.files.length} indexed files: ${names.join(", ")})`,
    exports.length ? `Exports: ${exports.map((e) => `${e.name} (${e.kind}, ${e.file})`).join(", ")}` : null,
    depends.length ? `Depends on: ${depends.join(", ")}` : null,
    externals.length ? `External imports: ${externals.join(", ")}` : null,
  ].filter(Boolean).join("\n");

  return row("code_module", content, {
    path: module.key,
    languages,
    files: module.files.map((f) => f.path),
    exports: exports.map((e) => ({ name: e.name, kind: e.kind, path: e.path, start_line: e.start_line })),
    depends_on: depends,
    external_imports: externals,
  }, metadata);
}

/**
 * `outlines` must be in relevance order (the selection order). Modules are ordered by indexed
 * file count, then path; file summaries keep relevance order. Same input, same rows.
 */
export function buildCodeMemory(
  outlines: readonly FileOutline[],
  { commitSha, parserVersion }: { commitSha: string; parserVersion: string },
): CodeMemoryRow[] {
  const metadata = { source: "code_index", parser_version: parserVersion, commit_sha: commitSha };

  const modules = new Map<string, ModuleAcc>();
  for (const outline of outlines) {
    const key = moduleKey(outline.path);
    const module = modules.get(key) ?? { key, files: [] };
    module.files.push(outline);
    modules.set(key, module);
  }
  const moduleRows = [...modules.values()]
    .sort((a, b) => b.files.length - a.files.length || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .slice(0, CODE_MEMORY_LIMITS.maxModules)
    .map((m) => codeModuleRow(m, metadata));

  const fileRows = outlines
    .filter((o) => o.symbols.length > 0)
    .slice(0, CODE_MEMORY_LIMITS.maxFileSummaries)
    .map((o) => fileSummaryRow(o, metadata));

  return [...moduleRows, ...fileRows];
}
