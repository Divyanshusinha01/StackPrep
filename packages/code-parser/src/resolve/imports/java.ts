import type { PathIndex } from "../paths.ts";
import type { ImportTarget } from "../types.ts";
import { external, fromMatches, resolvedDir } from "./result.ts";

/**
 * `a.b.C` matches a unique `a/b/C.java` path suffix; a static import (`a.b.C.member`) falls back to
 * the class one segment up; `a.b.*` matches the package directory. Unmatched imports are external.
 */
export function resolveJavaImport(source: string, names: readonly string[], index: PathIndex): ImportTarget {
  const segments = source.split(".");
  if (names.includes("*")) {
    const dirs = index.dirsBySuffix(segments.join("/"), ".java");
    return fromMatches(dirs, external, (dir) => resolvedDir(dir, index.dirs.get(dir)!.filter((p) => p.endsWith(".java"))));
  }
  for (let k = segments.length; k >= Math.max(segments.length - 1, 1); k--) {
    const matches = index.bySuffix(`${segments.slice(0, k).join("/")}.java`);
    if (matches.length > 0) return fromMatches(matches, external);
  }
  return external();
}
