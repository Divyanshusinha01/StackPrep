import { languageGroup, pathIndexFor, type PathIndex } from "../paths.ts";
import type { ImportTarget } from "../types.ts";
import { resolveCInclude } from "./c.ts";
import { resolveEcmascriptImport } from "./ecmascript.ts";
import { resolveGoImport } from "./go.ts";
import { resolveJavaImport } from "./java.ts";
import { resolvePythonImport } from "./python.ts";
import { unresolved } from "./result.ts";

export { goImportBinding } from "./go.ts";

/**
 * Path-only resolution of one import against the known repository paths. Never reads files or
 * build configuration (no tsconfig paths, go.mod, include paths or package metadata).
 */
export function resolveImport(
  fromPath: string,
  language: string | null,
  source: string,
  knownPaths: ReadonlySet<string> | PathIndex,
  names: readonly string[] = [],
): ImportTarget {
  const index = pathIndexFor(knownPaths);
  switch (languageGroup(language)) {
    case "ecmascript":
      return resolveEcmascriptImport(fromPath, source, index);
    case "python":
      return resolvePythonImport(fromPath, source, index);
    case "go":
      return resolveGoImport(source, index);
    case "java":
      return resolveJavaImport(source, names, index);
    case "c":
      return resolveCInclude(fromPath, source, index);
    default:
      return unresolved();
  }
}
