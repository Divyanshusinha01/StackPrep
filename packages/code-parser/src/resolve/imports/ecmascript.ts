import { dirname, normalize, type PathIndex } from "../paths.ts";
import type { ImportTarget } from "../types.ts";
import { external, resolvedFile, unresolved } from "./result.ts";

const EXTENSIONS = ["", ".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];
const INDEX = ["/index.ts", "/index.tsx", "/index.js", "/index.jsx", "/index.mjs"];

/**
 * Relative specifiers only: tries the usual extensions and index files (and `.ts` for a `.js`
 * written in TypeScript sources). Bare specifiers are packages or aliases, so external.
 */
export function resolveEcmascriptImport(fromPath: string, source: string, index: PathIndex): ImportTarget {
  if (!source.startsWith("./") && !source.startsWith("../")) return external();
  const base = normalize(`${dirname(fromPath)}/${source}`);
  if (!base) return unresolved();
  const stemmed = base.replace(/\.(m|c)?jsx?$/, "");
  const candidates = [
    ...EXTENSIONS.map((ext) => `${base}${ext}`),
    ...(stemmed !== base ? [".ts", ".tsx", ".mts", ".cts"].map((ext) => `${stemmed}${ext}`) : []),
    ...INDEX.map((suffix) => `${base}${suffix}`),
  ];
  const hit = candidates.find((c) => index.files.has(c));
  return hit ? resolvedFile(hit) : unresolved();
}
