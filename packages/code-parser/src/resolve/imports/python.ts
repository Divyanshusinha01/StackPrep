import { dirname, type PathIndex } from "../paths.ts";
import type { ImportTarget } from "../types.ts";
import { external, fromMatches, resolvedFile, unresolved } from "./result.ts";

const moduleFiles = (base: string) => [`${base}.py`, `${base}.pyi`, `${base}/__init__.py`];

/**
 * Leading-dot imports resolve against the importing file's package. Absolute dotted modules match
 * a known module or package at the root, else a unique path suffix (src layouts); else external.
 */
export function resolvePythonImport(fromPath: string, source: string, index: PathIndex): ImportTarget {
  const relative = /^(\.+)([\w.]*)$/.exec(source);
  if (relative) {
    let dir = dirname(fromPath);
    for (let i = 1; i < relative[1]!.length; i++) {
      if (!dir) return unresolved();
      dir = dirname(dir);
    }
    const rest = relative[2] ? relative[2].split(".").join("/") : "";
    const base = [dir, rest].filter(Boolean).join("/");
    const hit = base ? moduleFiles(base).find((c) => index.files.has(c)) : undefined;
    return hit ? resolvedFile(hit) : unresolved();
  }
  if (!/^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/.test(source)) return unresolved();
  const base = source.split(".").join("/");
  const exact = moduleFiles(base).find((c) => index.files.has(c));
  if (exact) return resolvedFile(exact);
  for (const candidate of moduleFiles(base)) {
    const matches = index.bySuffix(candidate);
    if (matches.length > 0) return fromMatches(matches, external);
  }
  return external();
}
