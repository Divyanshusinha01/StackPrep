import { goImportBinding, resolveImport } from "./imports/index.ts";
import { createPathIndex, dirname, isHeaderPath, languageGroup, stem, type LanguageGroup, type PathIndex } from "./paths.ts";
import type {
  CallConfidence,
  CallEdge,
  CallVia,
  ImportTarget,
  ProjectFile,
  ProjectGraph,
  ProjectInput,
  ResolvedImport,
  ResolveLimit,
  ResolveOptions,
  ResolverCall,
  ResolverSymbol,
  SymbolRef,
} from "./types.ts";

const DEFAULTS = { maxCandidates: 5, maxEdges: 50_000, timeBudgetMs: 5_000, maxIncludeDepth: 8 };
const CALLABLE = new Set(["function", "method", "class"]);
const CONTAINERS = new Set(["class", "interface"]);
const SCOPES = new Set(["class", "interface", "module", "enum"]);
const SELF = new Set(["this", "self"]);
const MAX_REEXPORT_DEPTH = 3;
const MAX_INCLUDE_FILES = 256;
const TIME_CHECK_EVERY = 128;
const IDENT = /^~?[A-Za-z_$][\w$]*$/;

/** Internal symbol reference by file and symbol index. */
interface Ref {
  f: number;
  s: number;
}

interface FileInfo {
  path: string;
  group: LanguageGroup;
  symbols: readonly ResolverSymbol[];
  file: ProjectFile;
  imports: ImportTarget[];
  /** Top-level symbols and members of namespaces/modules, by name. */
  free: Map<string, number[]>;
  /** Children by parent symbol index, then name. */
  members: Map<number, Map<string, number[]>>;
  byName: Map<string, number[]>;
  reachable?: number[];
  includes?: number[];
}

interface ParsedCallee {
  name: string;
  /** Segments before the name; null when the receiver is an expression (`a().b`). */
  qualifier: string[] | null;
}

interface Outcome {
  refs: Ref[];
  via: CallVia;
  /** Steps whose single match is not proof enough (the whole-project fallback) stay ambiguous. */
  weak?: boolean;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `int app::Store::get() const` -> ["app", "Store"] for `get`. */
export function signatureQualifier(signature: string | null, name: string): string[] {
  if (!signature) return [];
  const match = new RegExp(`((?:[A-Za-z_]\\w*(?:<[^<>()]*>)?\\s*::\\s*)+)${escapeRegExp(name)}\\s*\\(`).exec(signature);
  if (!match) return [];
  return match[1]!.split("::").map((s) => {
    const lt = s.indexOf("<");
    return (lt === -1 ? s : s.slice(0, lt)).trim();
  }).filter(Boolean);
}

export function parseCallee(text: string): ParsedCallee | null {
  let flat = text;
  for (let i = 0; i < 3 && /<[^<>]*>/.test(flat); i++) flat = flat.replace(/<[^<>]*>/g, "");
  const parts = flat.split(/\.|->|::/).map((p) => p.trim());
  if (parts[0] === "") parts.shift();
  const name = parts.pop() ?? "";
  if (!IDENT.test(name)) return null;
  return { name, qualifier: parts.every((p) => IDENT.test(p)) ? parts : null };
}

const isDeclaration = (s: ResolverSymbol) => s.signature !== null && /;\s*$/.test(s.signature);

export function resolveProject(input: ProjectInput, options: ResolveOptions = {}): ProjectGraph {
  const opts = { ...DEFAULTS, ...options };
  const now = options.now ?? (() => performance.now());
  const deadline = now() + opts.timeBudgetMs;
  const index: PathIndex = createPathIndex(input.knownPaths ?? input.files.map((f) => f.path));

  const files: FileInfo[] = [...input.files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((file) => indexFile(file, index));
  const byPath = new Map(files.map((f, i) => [f.path, i]));
  const key = (r: Ref) => `${r.f}:${r.s}`;
  const sym = (r: Ref) => files[r.f]!.symbols[r.s]!;

  const globalByName = new Map<string, Ref[]>();
  const definitionsByName = new Map<string, Ref[]>();
  files.forEach((info, f) => {
    info.symbols.forEach((s, i) => {
      if (CALLABLE.has(s.kind)) push(globalByName, s.name, { f, s: i });
      if (info.group === "c" && (s.kind === "function" || s.kind === "method") && !isDeclaration(s)) {
        push(definitionsByName, s.name, { f, s: i });
      }
    });
  });

  const chainCache = new Map<string, string>();
  /** Enclosing scope names plus a C++ out-of-line qualifier, joined with `::`. */
  const chain = (r: Ref): string => {
    const k = key(r);
    let value = chainCache.get(k);
    if (value === undefined) {
      const info = files[r.f]!;
      const names: string[] = [];
      for (let p = info.symbols[r.s]!.parentIndex; p !== null; p = info.symbols[p]!.parentIndex) names.unshift(info.symbols[p]!.name);
      if (info.group === "c") names.push(...signatureQualifier(info.symbols[r.s]!.signature, info.symbols[r.s]!.name));
      value = names.join("::");
      chainCache.set(k, value);
    }
    return value;
  };

  const fileIndexes = (paths: readonly string[]) => paths.flatMap((p) => (byPath.has(p) ? [byPath.get(p)!] : []));

  /** Transitive `#include` closure (resolved quoted includes only), excluding the file itself. */
  const includesOf = (f: number): number[] => {
    const info = files[f]!;
    if (info.includes) return info.includes;
    const seen = new Set([f]);
    let frontier = [f];
    for (let depth = 0; depth < opts.maxIncludeDepth && frontier.length > 0 && seen.size < MAX_INCLUDE_FILES; depth++) {
      const next: number[] = [];
      for (const g of frontier) {
        for (const target of files[g]!.imports) {
          for (const t of fileIndexes(target.files)) {
            if (!seen.has(t) && seen.size < MAX_INCLUDE_FILES) {
              seen.add(t);
              next.push(t);
            }
          }
        }
      }
      frontier = next;
    }
    seen.delete(f);
    info.includes = [...seen].sort((a, b) => a - b);
    return info.includes;
  };

  /** The file, its import targets (include closure for C/C++), and package siblings for Go/Java. */
  const reachableOf = (f: number): number[] => {
    const info = files[f]!;
    if (info.reachable) return info.reachable;
    const out = new Set([f]);
    if (info.group === "c") includesOf(f).forEach((t) => out.add(t));
    else info.imports.forEach((t) => fileIndexes(t.files).forEach((g) => out.add(g)));
    if (info.group === "go" || info.group === "java") {
      for (const sibling of fileIndexes(index.dirs.get(dirname(info.path)) ?? [])) {
        if (files[sibling]!.group === info.group) out.add(sibling);
      }
    }
    info.reachable = [...out].sort((a, b) => a - b);
    return info.reachable;
  };

  /** Free symbols named `name` in a file, following ECMAScript re-exports and Java class members. */
  const lookupFree = (f: number, name: string, depth = 0): Ref[] => {
    const info = files[f]!;
    const direct = (info.free.get(name) ?? []).map((s) => ({ f, s }));
    if (direct.length > 0) return direct;
    if (info.group === "java") {
      return info.symbols.flatMap((s, i) =>
        s.parentIndex === null && CONTAINERS.has(s.kind) ? (info.members.get(i)?.get(name) ?? []).map((m) => ({ f, s: m })) : []
      );
    }
    if (info.group !== "ecmascript" || depth >= MAX_REEXPORT_DEPTH) return [];
    return info.file.facts.imports.flatMap((imp, i) =>
      imp.kind === "reexport" && (imp.names.includes(name) || imp.names.includes("*"))
        ? fileIndexes(info.imports[i]!.files).flatMap((t) => lookupFree(t, name, depth + 1))
        : []
    );
  };

  const membersOf = (container: Ref, name: string): Ref[] =>
    (files[container.f]!.members.get(container.s)?.get(name) ?? []).map((s) => ({ f: container.f, s }));

  /** Containers named `name` that are free in a file. */
  const freeContainers = (f: number, name: string, kinds: Set<string>): Ref[] =>
    (files[f]!.byName.get(name) ?? []).filter((s) => kinds.has(files[f]!.symbols[s]!.kind)).map((s) => ({ f, s }));

  const enclosingClass = (f: number, caller: number | null): Ref | null => {
    const info = files[f]!;
    for (let p = caller; p !== null; p = info.symbols[p]!.parentIndex) {
      if (CONTAINERS.has(info.symbols[p]!.kind)) return { f, s: p };
    }
    if (info.group !== "c" || caller === null) return null;
    // C++ out-of-line method: the class named by the definition's qualifier.
    const qualifier = signatureQualifier(info.symbols[caller]!.signature, info.symbols[caller]!.name);
    const className = qualifier[qualifier.length - 1];
    if (!className) return null;
    for (const scope of [[f], includesOf(f)]) {
      const found = scope.flatMap((g) => freeContainers(g, className, CONTAINERS).concat(
        [...files[g]!.members.values()].flatMap((m) => (m.get(className) ?? []).map((s) => ({ f: g, s })))
          .filter((r) => CONTAINERS.has(sym(r).kind)),
      ));
      const unique = dedupe(found);
      if (unique.length === 1) return unique[0]!;
      if (unique.length > 1) return null;
    }
    return null;
  };

  function dedupe(refs: Ref[]): Ref[] {
    const seen = new Set<string>();
    return refs.filter((r) => {
      const k = key(r);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  /** Overloads and forward declarations in one scope count once, preferring a definition. */
  function collapse(refs: Ref[]): Ref[] {
    const groups = new Map<string, Ref>();
    for (const r of dedupe(refs)) {
      const s = sym(r);
      const k = `${r.f}:${s.parentIndex ?? "-"}:${s.name}`;
      const prev = groups.get(k);
      if (!prev || (isDeclaration(sym(prev)) && !isDeclaration(s))) groups.set(k, r);
    }
    return [...groups.values()].sort((a, b) => a.f - b.f || a.s - b.s);
  }

  /** C/C++ declarations (header prototypes, in-class methods) map to their definition when one is found. */
  const toDefinition = (r: Ref): Ref => {
    const info = files[r.f]!;
    const s = info.symbols[r.s]!;
    if (info.group !== "c" || (s.kind !== "function" && s.kind !== "method")) return r;
    if (!isHeaderPath(info.path) && !isDeclaration(s)) return r;
    const want = chain(r);
    const defs = (definitionsByName.get(s.name) ?? []).filter((d) => {
      if (d.f === r.f && d.s === r.s) return false;
      const dInfo = files[d.f]!;
      if (d.f !== r.f && (isHeaderPath(dInfo.path) || !sym(d).exported)) return false;
      return chain(d) === want;
    });
    if (defs.length === 0) return r;
    const sameFile = defs.filter((d) => d.f === r.f);
    if (sameFile.length > 0) return sameFile[0]!;
    const sameStem = defs.filter((d) => stem(files[d.f]!.path) === stem(info.path));
    if (sameStem.length === 1) return sameStem[0]!;
    return defs.length === 1 ? defs[0]! : r;
  };

  function resolveCall(f: number, call: ResolverCall): Outcome | null {
    const info = files[f]!;
    const parsed = parseCallee(call.calleeText);
    if (!parsed) return null;
    const { name, qualifier } = parsed;
    const first = (...steps: (() => Outcome | null)[]) => {
      for (const step of steps) {
        const out = step();
        if (out && out.refs.length > 0) return out;
      }
      return null;
    };

    return first(
      // Members of the enclosing class: `this.x` / `self.x`, and bare calls in Java and C++.
      () => {
        const selfCall = qualifier?.length === 1 && SELF.has(qualifier[0]!);
        const bareMember = qualifier?.length === 0 && (info.group === "java" || info.group === "c");
        if (!selfCall && !bareMember) return null;
        const cls = enclosingClass(f, call.enclosingSymbolIndex);
        return cls ? { refs: membersOf(cls, name), via: "member" } : null;
      },
      () => (qualifier ? { refs: importBinding(f, name, qualifier), via: "import" } : null),
      // Same file, then same-package files for Go and Java.
      () => {
        if (qualifier?.length !== 0) return null;
        const callable = (r: Ref) => CALLABLE.has(sym(r).kind);
        const local = (info.free.get(name) ?? []).map((s) => ({ f, s })).filter(callable);
        if (local.length > 0 || (info.group !== "go" && info.group !== "java")) return { refs: local, via: "local" };
        const siblings = reachableOf(f).filter((g) => g !== f && dirname(files[g]!.path) === dirname(info.path));
        return { refs: siblings.flatMap((g) => (files[g]!.free.get(name) ?? []).map((s) => ({ f: g, s }))).filter(callable), via: "local" };
      },
      () => (qualifier && qualifier.length > 0 && !SELF.has(qualifier[0]!) ? qualified(f, name, qualifier[qualifier.length - 1]!) : null),
      () => fallback(f, name, qualifier, reachableOf(f), "reachable"),
      () => fallback(f, name, qualifier, null, "global"),
    );
  }

  function importBinding(f: number, name: string, qualifier: string[]): Ref[] {
    const info = files[f]!;
    const imports = info.file.facts.imports;
    if (qualifier.length === 0) {
      if (info.group === "c") return includesOf(f).flatMap((t) => lookupFree(t, name));
      if (info.group === "go") return [];
      return imports.flatMap((imp, i) =>
        imp.names.includes(name) ? fileIndexes(info.imports[i]!.files).flatMap((t) => lookupFree(t, name)) : []
      );
    }
    const q0 = qualifier[0]!;
    const out: Ref[] = [];
    const namespaceHits: Ref[][] = [];
    imports.forEach((imp, i) => {
      const targets = fileIndexes(info.imports[i]!.files);
      switch (info.group) {
        case "go":
          if (qualifier.length === 1 && goImportBinding(imp.source, imp.names) === q0) {
            out.push(...targets.flatMap((t) => (files[t]!.free.get(name) ?? []).map((s) => ({ f: t, s }))));
          }
          break;
        case "python":
          if (imp.names.length === 0 && qualifier.join(".") === imp.source) {
            out.push(...targets.flatMap((t) => lookupFree(t, name)));
          } else if (qualifier.length === 1 && imp.names.includes(q0)) {
            const module = imp.source.endsWith(".") ? `${imp.source}${q0}` : `${imp.source}.${q0}`;
            const submodule = fileIndexes(resolveImport(info.path, "python", module, index).files);
            out.push(...(submodule.length > 0
              ? submodule.flatMap((t) => lookupFree(t, name))
              : targets.flatMap((t) => freeContainers(t, q0, CONTAINERS).flatMap((c) => membersOf(c, name)))));
          }
          break;
        case "ecmascript":
        case "java":
          if (qualifier.length !== 1) break;
          if (imp.names.includes(q0)) {
            out.push(...targets.flatMap((t) => freeContainers(t, q0, SCOPES).flatMap((c) => membersOf(c, name))));
          } else if (info.group === "ecmascript" && imp.names.includes("*")) {
            namespaceHits.push(targets.flatMap((t) => lookupFree(t, name)));
          }
          break;
      }
    });
    // `import * as ns` keeps no alias, so `ns.f()` binds only when exactly one namespace import exports `f`.
    const nonEmpty = namespaceHits.filter((hits) => hits.length > 0);
    if (out.length === 0 && nonEmpty.length === 1) out.push(...nonEmpty[0]!);
    return out;
  }

  /** `Parent.name` / `ns::name`: in the file, then import-reachable files, then the whole project. */
  function qualified(f: number, name: string, q: string): Outcome | null {
    const matchesIn = (g: number): Ref[] => {
      const scoped = freeContainers(g, q, SCOPES).flatMap((c) => membersOf(c, name));
      if (files[g]!.group !== "c") return scoped;
      const outOfLine = (files[g]!.byName.get(name) ?? [])
        .map((s) => ({ f: g, s }))
        .filter((r) => chain(r).split("::").pop() === q);
      return scoped.concat(outOfLine);
    };
    for (const scope of [[f], reachableOf(f).filter((g) => g !== f), files.map((_, g) => g)]) {
      const refs = collapse(scope.flatMap(matchesIn));
      if (refs.length > 0) return { refs, via: "qualified" };
    }
    return null;
  }

  /**
   * Unique-by-name among callable symbols. Bare calls only match free functions and classes; calls
   * on a receiver match any callable. Outside import-reachable files only exported symbols count,
   * and a match there is never more than ambiguous.
   */
  function fallback(f: number, name: string, qualifier: string[] | null, scope: number[] | null, via: CallVia): Outcome {
    const bare = qualifier !== null && qualifier.length === 0;
    const allowed = scope ? new Set(scope) : null;
    const refs = (globalByName.get(name) ?? []).filter((r) => {
      if (allowed && !allowed.has(r.f)) return false;
      const s = sym(r);
      if (bare && (s.kind === "method" || !files[r.f]!.free.get(name)?.includes(r.s))) return false;
      return allowed !== null || r.f === f || s.exported;
    });
    return { refs, via, weak: scope === null };
  }

  // Edges -------------------------------------------------------------------

  const calls: CallEdge[] = [];
  const limitsHit = new Set<ResolveLimit>();
  let processed = 0;
  let outOfTime = false;
  const toPublic = (r: Ref): SymbolRef => ({ file: files[r.f]!.path, symbol: r.s });

  outer: for (const [f, info] of files.entries()) {
    for (const [callIndex, call] of info.file.facts.calls.entries()) {
      if (calls.length >= opts.maxEdges) {
        limitsHit.add("maxEdges");
        break outer;
      }
      if (!outOfTime && ++processed % TIME_CHECK_EVERY === 0 && now() > deadline) {
        outOfTime = true;
        limitsHit.add("timeBudget");
      }
      const outcome = outOfTime ? null : resolveCall(f, call);
      const refs = outcome ? collapse(outcome.refs.map(toDefinition)) : [];
      const confidence: CallConfidence = refs.length === 0 ? "unresolved" : refs.length === 1 && !outcome!.weak ? "resolved" : "ambiguous";
      const target = confidence === "resolved" ? refs[0]! : null;
      calls.push({
        fromFile: info.path,
        callIndex,
        callerSymbol: call.enclosingSymbolIndex,
        calleeText: call.calleeText,
        toFile: target ? files[target.f]!.path : null,
        toSymbol: target ? target.s : null,
        confidence,
        via: refs.length > 0 ? outcome!.via : null,
        candidates: refs.slice(0, opts.maxCandidates).map(toPublic),
        candidateCount: refs.length,
      });
    }
  }

  const imports: ResolvedImport[] = files.flatMap((info) =>
    info.imports.map((target, importIndex) => ({ ...target, file: info.path, importIndex, source: info.file.facts.imports[importIndex]!.source }))
  );

  let callers: Map<string, CallEdge[]> | null = null;
  let callees: Map<string, CallEdge[]> | null = null;
  const refKey = (file: string, symbol: number) => `${file}\u0000${symbol}`;

  return {
    imports,
    calls,
    limitsHit: [...limitsHit].sort(),
    callersOf(file, symbol) {
      if (!callers) {
        callers = new Map();
        for (const edge of calls.filter((e) => e.confidence === "resolved")) push(callers, refKey(edge.toFile!, edge.toSymbol!), edge);
        for (const edge of calls.filter((e) => e.confidence === "ambiguous")) {
          for (const c of edge.candidates) push(callers, refKey(c.file, c.symbol), edge);
        }
      }
      return callers.get(refKey(file, symbol)) ?? [];
    },
    calleesOf(file, symbol) {
      if (!callees) {
        callees = new Map();
        for (const edge of calls) if (edge.callerSymbol !== null) push(callees, refKey(edge.fromFile, edge.callerSymbol), edge);
      }
      return callees.get(refKey(file, symbol)) ?? [];
    },
  };
}

function indexFile(file: ProjectFile, index: PathIndex): FileInfo {
  const symbols = file.facts.symbols;
  const free = new Map<string, number[]>();
  const members = new Map<number, Map<string, number[]>>();
  const byName = new Map<string, number[]>();
  symbols.forEach((s, i) => {
    push(byName, s.name, i);
    const parent = s.parentIndex !== null && s.parentIndex >= 0 && s.parentIndex < i ? s.parentIndex : null;
    if (parent === null || symbols[parent]!.kind === "module") push(free, s.name, i);
    if (parent !== null) {
      let byChild = members.get(parent);
      if (!byChild) members.set(parent, (byChild = new Map()));
      push(byChild, s.name, i);
    }
  });
  return {
    path: file.path,
    group: languageGroup(file.language),
    symbols,
    file,
    imports: file.facts.imports.map((imp) => resolveImport(file.path, file.language, imp.source, index, imp.names)),
    free,
    members,
    byName,
  };
}
