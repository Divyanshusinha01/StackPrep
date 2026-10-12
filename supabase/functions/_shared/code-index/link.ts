/**
 * Turns a commit's stored facts into `replace_code_edges` payloads through the shared project
 * resolver. Pure: loading facts and writing edges belong to the caller.
 */
import { type ProjectFile, type ProjectGraph, type ResolveOptions, resolveProject } from "@stackprep/code-parser";

/** Files per `replace_code_edges` call, and edge rows across them; both match the database caps. */
export const EDGE_BATCH_FILES = 100;
export const EDGE_BATCH_ROWS = 20000;

/** One element of `load_code_link_facts`; ordinals are array indices. */
export interface CodeLinkFile {
  path: string;
  language: string | null;
  symbols: { name: string; kind: string; parent_ord: number | null; exported: boolean; signature: string | null }[];
  imports: { source: string; kind: string; names: string[] }[];
  calls: { caller_ord: number | null; callee_text: string }[];
}

export interface CodeEdgePayload {
  call_ord: number;
  target_path: string;
  target_ord: number;
  confidence: "resolved" | "ambiguous";
  candidate_count: number;
}

/** One element of `replace_code_edges`' `p_files`; an empty `edges` clears the file's edges. */
export interface CodeEdgeFilePayload {
  path: string;
  edges: CodeEdgePayload[];
}

export interface LinkSummary {
  files: number;
  edges_resolved: number;
  edges_ambiguous: number;
  calls_unresolved: number;
  limits_hit: string[];
}

export function toProjectFile(file: CodeLinkFile): ProjectFile {
  return {
    path: file.path,
    language: file.language,
    facts: {
      symbols: file.symbols.map((s) => ({
        name: s.name,
        kind: s.kind,
        parentIndex: s.parent_ord,
        exported: s.exported,
        signature: s.signature,
      })),
      imports: file.imports.map((i) => ({ source: i.source, kind: i.kind, names: i.names })),
      calls: file.calls.map((c) => ({ calleeText: c.callee_text, enclosingSymbolIndex: c.caller_ord })),
    },
  };
}

/**
 * Resolved calls become one row; ambiguous calls one row per kept candidate, each carrying the
 * full candidate count. Unresolved calls get no row, so readers fall back to name matching.
 * Every input file is listed (possibly with no edges) so reruns replace stale rows.
 */
export function linkFiles(
  files: readonly CodeLinkFile[],
  knownPaths: Iterable<string>,
  options: ResolveOptions = {},
): { payloads: CodeEdgeFilePayload[]; summary: LinkSummary } {
  const graph: ProjectGraph = resolveProject({ files: files.map(toProjectFile), knownPaths }, options);
  const byFile = new Map<string, CodeEdgePayload[]>(files.map((f) => [f.path, []]));
  const summary: LinkSummary = {
    files: files.length,
    edges_resolved: 0,
    edges_ambiguous: 0,
    calls_unresolved: 0,
    limits_hit: [...graph.limitsHit],
  };
  for (const edge of graph.calls) {
    const rows = byFile.get(edge.fromFile);
    if (!rows || edge.confidence === "unresolved") {
      summary.calls_unresolved += edge.confidence === "unresolved" ? 1 : 0;
      continue;
    }
    if (edge.confidence === "resolved" && edge.toFile !== null && edge.toSymbol !== null) {
      rows.push({ call_ord: edge.callIndex, target_path: edge.toFile, target_ord: edge.toSymbol, confidence: "resolved", candidate_count: 1 });
      summary.edges_resolved++;
      continue;
    }
    if (edge.confidence === "ambiguous") {
      const seen = new Set<string>();
      for (const c of edge.candidates) {
        const key = `${c.file}\u0000${c.symbol}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        rows.push({
          call_ord: edge.callIndex,
          target_path: c.file,
          target_ord: c.symbol,
          confidence: "ambiguous",
          candidate_count: Math.max(edge.candidateCount, 2),
        });
      }
      summary.edges_ambiguous++;
    }
  }
  const payloads = files.map((f) => ({ path: f.path, edges: byFile.get(f.path) ?? [] }));
  return { payloads, summary };
}

/** Splits payloads so each batch stays within `EDGE_BATCH_FILES` files and `EDGE_BATCH_ROWS` rows. */
export function batchEdgePayloads(payloads: readonly CodeEdgeFilePayload[]): CodeEdgeFilePayload[][] {
  const batches: CodeEdgeFilePayload[][] = [];
  let current: CodeEdgeFilePayload[] = [];
  let rows = 0;
  for (const payload of payloads) {
    if (current.length > 0 && (current.length >= EDGE_BATCH_FILES || rows + payload.edges.length > EDGE_BATCH_ROWS)) {
      batches.push(current);
      current = [];
      rows = 0;
    }
    current.push(payload);
    rows += payload.edges.length;
  }
  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}
