import type { ImportTarget } from "../types.ts";

export const MAX_IMPORT_CANDIDATES = 10;

export const external = (): ImportTarget => ({ resolvedPath: null, resolution: "external", candidates: [], files: [] });
export const unresolved = (): ImportTarget => ({ resolvedPath: null, resolution: "unresolved", candidates: [], files: [] });

export const resolvedFile = (path: string): ImportTarget => ({ resolvedPath: path, resolution: "resolved", candidates: [], files: [path] });

export const resolvedDir = (dir: string, files: readonly string[]): ImportTarget => ({
  resolvedPath: `${dir}/`,
  resolution: "resolved",
  candidates: [],
  files: [...files],
});

/** One match resolves, several are ambiguous (nothing is brought into scope), none falls back to `none`. */
export function fromMatches(matches: readonly string[], none: () => ImportTarget, toTarget = resolvedFile): ImportTarget {
  if (matches.length === 1) return toTarget(matches[0]!);
  if (matches.length > 1) {
    return { resolvedPath: null, resolution: "ambiguous", candidates: matches.slice(0, MAX_IMPORT_CANDIDATES), files: [] };
  }
  return none();
}
