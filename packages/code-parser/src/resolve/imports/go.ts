import type { PathIndex } from "../paths.ts";
import type { ImportTarget } from "../types.ts";
import { external, fromMatches, resolvedDir } from "./result.ts";

/**
 * A Go import names a package directory. Without go.mod, the longest suffix of at least two
 * segments that matches a directory with `.go` files wins (exact root match preferred); single
 * segment paths are the standard library. Unmatched imports are external modules.
 */
export function resolveGoImport(source: string, index: PathIndex): ImportTarget {
  const segments = source.split("/").filter(Boolean);
  if (segments.length < 2) return external();
  const toTarget = (dir: string) => resolvedDir(dir, index.dirs.get(dir)!.filter((p) => p.endsWith(".go")));
  for (let k = segments.length; k >= 2; k--) {
    const suffix = segments.slice(-k).join("/");
    const matches = index.dirsBySuffix(suffix, ".go");
    if (matches.length === 0) continue;
    const exact = matches.filter((d) => d === suffix);
    return fromMatches(exact.length === 1 ? exact : matches, external, toTarget);
  }
  return external();
}

/** The identifier a Go import binds: its alias, else the last path segment. */
export function goImportBinding(source: string, names: readonly string[]): string | null {
  const alias = names[0];
  if (alias === "_" || alias === ".") return null;
  return alias ?? source.split("/").pop() ?? null;
}
