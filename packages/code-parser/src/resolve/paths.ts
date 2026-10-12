export function dirname(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Basename without its last extension. */
export function stem(path: string): string {
  const base = basename(path);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/** Resolves `a/./b/../c` style segments; null when the path climbs above the repository root. */
export function normalize(path: string): string | null {
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else {
      out.push(segment);
    }
  }
  return out.length ? out.join("/") : null;
}

const HEADER = /\.(h|hh|hpp|hxx|ipp)$/i;

export function isHeaderPath(path: string): boolean {
  return HEADER.test(path);
}

export type LanguageGroup = "ecmascript" | "python" | "go" | "java" | "c" | "other";

export function languageGroup(language: string | null): LanguageGroup {
  switch (language) {
    case "typescript":
    case "tsx":
    case "javascript":
      return "ecmascript";
    case "python":
    case "go":
    case "java":
      return language;
    case "c":
    case "cpp":
      return "c";
    default:
      return "other";
  }
}

/** Lookup structure over the known repository paths, built once per path set. */
export interface PathIndex {
  files: ReadonlySet<string>;
  /** Files per directory ("" is the root). */
  dirs: ReadonlyMap<string, readonly string[]>;
  /** Paths that equal `suffix` or end with `/suffix`, sorted. */
  bySuffix(suffix: string): string[];
  /** Directories (with files of extension `ext`) that equal `suffix` or end with `/suffix`. */
  dirsBySuffix(suffix: string, ext: string): string[];
}

export function createPathIndex(paths: Iterable<string>): PathIndex {
  const files = new Set(paths);
  const byBase = new Map<string, string[]>();
  const dirs = new Map<string, string[]>();
  const dirsByLast = new Map<string, string[]>();
  for (const path of [...files].sort()) {
    const base = basename(path);
    (byBase.get(base) ?? byBase.set(base, []).get(base)!).push(path);
    const dir = dirname(path);
    if (!dirs.has(dir)) {
      dirs.set(dir, []);
      const last = basename(dir);
      (dirsByLast.get(last) ?? dirsByLast.set(last, []).get(last)!).push(dir);
    }
    dirs.get(dir)!.push(path);
  }
  return {
    files,
    dirs,
    bySuffix(suffix) {
      return (byBase.get(basename(suffix)) ?? []).filter((p) => p === suffix || p.endsWith(`/${suffix}`));
    },
    dirsBySuffix(suffix, ext) {
      return (dirsByLast.get(basename(suffix)) ?? []).filter((d) =>
        (d === suffix || d.endsWith(`/${suffix}`)) && dirs.get(d)!.some((p) => p.endsWith(ext))
      );
    },
  };
}

const cache = new WeakMap<object, PathIndex>();

/** Memoized per set instance, so per-file callers sharing one set build the index once. */
export function pathIndexFor(paths: ReadonlySet<string> | PathIndex): PathIndex {
  if ("bySuffix" in paths) return paths;
  let index = cache.get(paths);
  if (!index) {
    index = createPathIndex(paths);
    cache.set(paths, index);
  }
  return index;
}
