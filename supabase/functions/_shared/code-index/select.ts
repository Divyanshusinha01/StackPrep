/** Deterministic choice of which files the code index parses, and how they are split into steps. */
import { classifyPath, relevanceScore, type TreeEntry } from "../analysis/filter.ts";

export interface CodeIndexLimits {
  /** Tree entries beyond this are ignored, like the baseline analysis. */
  maxTreeEntries: number;
  /** Files recorded per commit, including oversized ones recorded as skipped. */
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  /**
   * One durable step parses at most this many files and bytes. Sized from the Edge spike: a
   * 25-file, ~380 KB batch used about 15% of the 2 s CPU limit, 1.6 MB came close to the limit.
   */
  batchFiles: number;
  batchBytes: number;
}

export const DEFAULT_CODE_INDEX_LIMITS: CodeIndexLimits = {
  maxTreeEntries: 20_000,
  maxFiles: 400,
  maxFileBytes: 64 * 1024,
  maxTotalBytes: 4 * 1024 * 1024,
  batchFiles: 25,
  batchBytes: 600 * 1024,
};

export type CodeIndexLimitHit = "tree_truncated" | "max_tree_entries" | "max_files" | "max_total_bytes";

export interface CodeIndexFile {
  path: string;
  sha: string;
  size: number;
  language: string;
  /** Set when the file is recorded without being fetched. */
  skip?: "too_large";
}

export interface CodeIndexSelection {
  /** In relevance order, then path. */
  files: CodeIndexFile[];
  /** Every readable path with a detected language; the only targets relative imports resolve to. */
  known_paths: string[];
  /** Parseable files in the tree before the caps. */
  candidates: number;
  limits_hit: CodeIndexLimitHit[];
}

export function selectCodeFiles(
  entries: readonly TreeEntry[],
  truncated: boolean,
  detectLanguage: (path: string) => string | null,
  limits: CodeIndexLimits = DEFAULT_CODE_INDEX_LIMITS,
): CodeIndexSelection {
  const limitsHit = new Set<CodeIndexLimitHit>();
  if (truncated) {
    limitsHit.add("tree_truncated");
  }
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (sorted.length > limits.maxTreeEntries) {
    limitsHit.add("max_tree_entries");
  }

  const candidates: { file: CodeIndexFile; score: number }[] = [];
  for (const entry of sorted.slice(0, limits.maxTreeEntries)) {
    if (entry.type !== "blob" || classifyPath(entry.path) !== null) {
      continue;
    }
    const language = detectLanguage(entry.path);
    if (language) {
      candidates.push({
        file: { path: entry.path, sha: entry.sha, size: entry.size ?? 0, language },
        score: relevanceScore(entry.path),
      });
    }
  }

  const knownPaths = candidates.map((c) => c.file.path);
  candidates.sort((a, b) => b.score - a.score || (a.file.path < b.file.path ? -1 : 1));

  const files: CodeIndexFile[] = [];
  let totalBytes = 0;
  for (const { file } of candidates) {
    if (files.length >= limits.maxFiles) {
      limitsHit.add("max_files");
      break;
    }
    if (file.size > limits.maxFileBytes) {
      files.push({ ...file, skip: "too_large" });
      continue;
    }
    if (totalBytes + file.size > limits.maxTotalBytes) {
      limitsHit.add("max_total_bytes");
      continue;
    }
    totalBytes += file.size;
    files.push(file);
  }

  return { files, known_paths: knownPaths, candidates: candidates.length, limits_hit: [...limitsHit].sort() };
}

/** Consecutive slices of `files` bounded by file count and fetched bytes; order is preserved. */
export function planBatches(files: readonly CodeIndexFile[], limits: CodeIndexLimits = DEFAULT_CODE_INDEX_LIMITS): CodeIndexFile[][] {
  const batches: CodeIndexFile[][] = [];
  let current: CodeIndexFile[] = [];
  let bytes = 0;
  for (const file of files) {
    const size = file.skip ? 0 : file.size;
    if (current.length > 0 && (current.length >= limits.batchFiles || bytes + size > limits.batchBytes)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(file);
    bytes += size;
  }
  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}
