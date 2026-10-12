/**
 * Input and output shapes of the project resolver. Inputs are a structural subset of `CodeFacts`
 * so parser output and facts loaded back from storage both fit without conversion.
 */

export interface ResolverSymbol {
  name: string;
  kind: string;
  parentIndex: number | null;
  exported: boolean;
  signature: string | null;
}

export interface ResolverImport {
  source: string;
  names: readonly string[];
  kind: string;
}

export interface ResolverCall {
  calleeText: string;
  enclosingSymbolIndex: number | null;
}

export interface ResolverFacts {
  symbols: readonly ResolverSymbol[];
  imports: readonly ResolverImport[];
  calls: readonly ResolverCall[];
}

export interface ProjectFile {
  path: string;
  /** Registry language id, or null for files without one (their calls still get edges). */
  language: string | null;
  facts: ResolverFacts;
}

export interface ProjectInput {
  files: readonly ProjectFile[];
  /** Every repository path imports may resolve to; defaults to the paths of `files`. */
  knownPaths?: Iterable<string>;
}

export interface ResolveOptions {
  /** Candidates kept per ambiguous call; `candidateCount` still reports the full count. Default 5. */
  maxCandidates?: number;
  /** Call edges produced before stopping. Default 50,000. */
  maxEdges?: number;
  /** Wall-clock budget; calls left when it runs out get `unresolved` edges. Default 5,000 ms. */
  timeBudgetMs?: number;
  /** Transitive `#include` depth followed for C/C++. Default 8. */
  maxIncludeDepth?: number;
  now?: () => number;
}

export type ImportResolution = "resolved" | "external" | "unresolved" | "ambiguous";

export interface ImportTarget {
  /** A repository file, or a directory with a trailing `/` for package imports (Go, Java `*`). */
  resolvedPath: string | null;
  resolution: ImportResolution;
  /** Matching paths when `ambiguous` (capped), otherwise empty. */
  candidates: string[];
  /** Files whose declarations the import brings into scope (a package import has several). */
  files: string[];
}

export interface ResolvedImport extends ImportTarget {
  file: string;
  importIndex: number;
  source: string;
}

export type CallConfidence = "resolved" | "ambiguous" | "unresolved";

/** Which rule decided the call: imported binding, same file, enclosing class, qualifier, import-reachable files, or the whole project. */
export type CallVia = "import" | "local" | "member" | "qualified" | "reachable" | "global";

export interface SymbolRef {
  file: string;
  symbol: number;
}

export interface CallEdge {
  fromFile: string;
  callIndex: number;
  callerSymbol: number | null;
  calleeText: string;
  /** Set only when `confidence` is `resolved`. */
  toFile: string | null;
  toSymbol: number | null;
  confidence: CallConfidence;
  via: CallVia | null;
  /** The target when resolved; the capped candidate list when ambiguous; empty when unresolved. */
  candidates: SymbolRef[];
  candidateCount: number;
}

export type ResolveLimit = "maxEdges" | "timeBudget";

export interface ProjectGraph {
  imports: ResolvedImport[];
  calls: CallEdge[];
  limitsHit: ResolveLimit[];
  /** Resolved edges into the symbol, then ambiguous edges listing it as a candidate. */
  callersOf(file: string, symbol: number): CallEdge[];
  /** Edges leaving call sites enclosed by the symbol, in source order. */
  calleesOf(file: string, symbol: number): CallEdge[];
}
