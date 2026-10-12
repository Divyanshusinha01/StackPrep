import { dirname, normalize, type PathIndex } from "../paths.ts";
import type { ImportTarget } from "../types.ts";
import { external, fromMatches, resolvedFile, unresolved } from "./result.ts";

/**
 * Quoted includes resolve relative to the including file's directory, then as a repository path,
 * then by a unique path suffix (`include/foo.h` for `"foo.h"`). Angle includes (kept with their
 * brackets by the parser) are system or library headers, so external. No include paths are known.
 */
export function resolveCInclude(fromPath: string, source: string, index: PathIndex): ImportTarget {
  if (source.startsWith("<")) return external();
  const relative = normalize(`${dirname(fromPath)}/${source}`);
  if (relative && index.files.has(relative)) return resolvedFile(relative);
  const cleaned = normalize(source.replace(/^(\.\.?\/)+/, ""));
  if (!cleaned) return unresolved();
  if (index.files.has(cleaned)) return resolvedFile(cleaned);
  return fromMatches(index.bySuffix(cleaned).filter((p) => p !== fromPath), unresolved);
}
