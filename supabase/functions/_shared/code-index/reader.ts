/**
 * Read access to the commit-pinned code index. Results are syntactic: matched by name or path as
 * written, or linked by the path-based call graph (never type-checked), so callers must not
 * present them as precise semantics.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

const MAX_FILE_SYMBOLS = 2_000;

/** Marks results as name-based and unresolved. */
export interface Syntactic<T> {
  resolution: "syntactic";
  results: T[];
}

export interface SymbolMatch {
  path: string;
  language: string | null;
  name: string;
  kind: string;
  parent_name: string | null;
  start_line: number;
  start_col: number;
  end_line: number;
  end_col: number;
  exported: boolean;
  signature: string | null;
  /** Case-insensitive full-name match, as opposed to a prefix match. */
  exact: boolean;
}

export interface SymbolSearchHit {
  path: string;
  language: string | null;
  name: string;
  kind: string;
  parent_name: string | null;
  start_line: number;
  end_line: number;
  exported: boolean;
  signature: string | null;
  matched_terms: number;
}

export interface FileSymbol {
  name: string;
  kind: string;
  parent: string | null;
  start_line: number;
  end_line: number;
  exported: boolean;
}

export interface Importer {
  path: string;
  source: string;
  kind: string;
  names: string[];
  resolved_path: string | null;
  line: number;
}

export type Dependency = Omit<Importer, "path">;

export interface CallSite {
  path: string;
  caller_name: string | null;
  caller_kind: string | null;
  callee_text: string;
  line: number;
  col: number;
  exact: boolean;
  /** True when the row comes from a call-graph edge rather than name matching. */
  resolved?: boolean;
  /** `resolved` or `ambiguous` for edge rows; null for the name fallback. */
  confidence?: string | null;
  target_path?: string | null;
  target_name?: string | null;
}

export interface FindCallersOptions {
  limit?: number;
  /** Narrows edge targets to symbols declared in this file. */
  file?: string;
  /** Narrows edge targets to this symbol, as `name` or `Parent.name`. */
  symbol?: string;
}

export interface CodeIndexReader {
  /** Symbols whose name contains any of `terms`; empty when the commit is not indexed. */
  searchSymbols(workspaceId: string, commitSha: string, terms: string[], limit: number, signal?: AbortSignal): Promise<SymbolSearchHit[]>;
  /** The file's symbols in source order, or null when the file is not indexed with facts. */
  fileSymbols(workspaceId: string, commitSha: string, path: string): Promise<FileSymbol[] | null>;
  findSymbol(workspaceId: string, commitSha: string, name: string, options?: { kind?: string; limit?: number }): Promise<Syntactic<SymbolMatch>>;
  /** Files importing `target` (a repository path matched through path-resolved relative imports, or a specifier). */
  findImporters(workspaceId: string, commitSha: string, target: string, limit?: number): Promise<Syntactic<Importer>>;
  findDependencies(workspaceId: string, commitSha: string, path: string, limit?: number): Promise<Syntactic<Dependency>>;
  /**
   * Call sites of `name`: calls linked to a matching declaration by the call graph first, then
   * calls whose callee's last segment matches the last segment of `name` and have no such link.
   */
  findCallers(
    workspaceId: string,
    commitSha: string,
    name: string,
    options?: number | FindCallersOptions,
  ): Promise<Syntactic<CallSite>>;
}

function check(action: string, error: { message: string } | null): void {
  if (error) {
    throw new Error(`Failed to ${action}: ${error.message}`);
  }
}

function syntactic<T>(results: T[]): Syntactic<T> {
  return { resolution: "syntactic", results };
}

/** Works with a service-role or user-scoped client; the read functions are security invoker. */
export function createCodeIndexReader(client: SupabaseClient): CodeIndexReader {
  return {
    async searchSymbols(workspaceId, commitSha, terms, limit, signal) {
      if (terms.length === 0) {
        return [];
      }
      let query = client.rpc("search_code_symbols", {
        p_workspace_id: workspaceId,
        p_commit_sha: commitSha,
        p_terms: terms,
        p_limit: limit,
      });
      if (signal) {
        query = query.abortSignal(signal);
      }
      const { data, error } = await query;
      check("search code symbols", error);
      return (data ?? []) as SymbolSearchHit[];
    },

    async fileSymbols(workspaceId, commitSha, path) {
      const { data: file, error } = await client
        .from("code_files")
        .select("id, parse_status")
        .eq("workspace_id", workspaceId)
        .eq("repository_commit_sha", commitSha)
        .eq("path", path)
        .maybeSingle();
      check("load code file", error);
      if (!file || (file.parse_status !== "ok" && file.parse_status !== "partial")) {
        return null;
      }
      const { data: rows, error: symbolsError } = await client
        .from("code_symbols")
        .select("ord, name, kind, parent_ord, start_line, end_line, exported")
        .eq("file_id", file.id)
        .order("ord")
        .limit(MAX_FILE_SYMBOLS);
      check("load code symbols", symbolsError);
      const symbols = (rows ?? []) as {
        ord: number;
        name: string;
        kind: string;
        parent_ord: number | null;
        start_line: number;
        end_line: number;
        exported: boolean;
      }[];
      const names = new Map(symbols.map((s) => [s.ord, s.name]));
      return symbols.map((s) => ({
        name: s.name,
        kind: s.kind,
        parent: s.parent_ord === null ? null : names.get(s.parent_ord) ?? null,
        start_line: s.start_line,
        end_line: s.end_line,
        exported: s.exported,
      }));
    },

    async findSymbol(workspaceId, commitSha, name, options = {}) {
      const { data, error } = await client.rpc("find_symbol", {
        p_workspace_id: workspaceId,
        p_commit_sha: commitSha,
        p_name: name,
        p_kind: options.kind ?? null,
        p_limit: options.limit ?? 20,
      });
      check("find symbol", error);
      return syntactic((data ?? []) as SymbolMatch[]);
    },

    async findImporters(workspaceId, commitSha, target, limit = 50) {
      const { data, error } = await client.rpc("find_importers", {
        p_workspace_id: workspaceId,
        p_commit_sha: commitSha,
        p_target: target,
        p_limit: limit,
      });
      check("find importers", error);
      return syntactic((data ?? []) as Importer[]);
    },

    async findDependencies(workspaceId, commitSha, path, limit = 100) {
      const { data, error } = await client.rpc("find_dependencies", {
        p_workspace_id: workspaceId,
        p_commit_sha: commitSha,
        p_path: path,
        p_limit: limit,
      });
      check("find dependencies", error);
      return syntactic((data ?? []) as Dependency[]);
    },

    async findCallers(workspaceId, commitSha, name, options = {}) {
      const { limit = 50, file, symbol } = typeof options === "number" ? { limit: options } : options;
      const { data, error } = await client.rpc("find_callers", {
        p_workspace_id: workspaceId,
        p_commit_sha: commitSha,
        p_name: name,
        p_limit: limit,
        p_file: file ?? null,
        p_symbol: symbol ?? null,
      });
      check("find callers", error);
      return syntactic((data ?? []) as CallSite[]);
    },
  };
}

/**
 * Picks the symbol a `get_file` request names: `name` or `Parent.name`, case-sensitive match
 * first, then case-insensitive; the first in source order wins.
 */
export function pickFileSymbol(symbols: readonly FileSymbol[], requested: string): FileSymbol | null {
  const wanted = requested.trim();
  const dot = wanted.lastIndexOf(".");
  const parent = dot > 0 ? wanted.slice(0, dot) : null;
  const name = dot > 0 ? wanted.slice(dot + 1) : wanted;
  const matches = (s: FileSymbol, fold: (t: string) => string) =>
    fold(s.name) === fold(name) && (parent === null || (s.parent !== null && fold(s.parent) === fold(parent)));
  const same = (t: string) => t;
  const lower = (t: string) => t.toLowerCase();
  return symbols.find((s) => matches(s, same)) ?? symbols.find((s) => matches(s, lower)) ??
    (parent !== null ? symbols.find((s) => s.name === wanted) ?? null : null);
}
