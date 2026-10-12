import type { Node, Point, QueryMatch, Tree } from "web-tree-sitter";
import type { LoadedLanguage } from "./engine.ts";
import { countLines, utf8Length } from "./limits.ts";
import { collapse, unquote } from "./text.ts";
import {
  SYMBOL_KINDS,
  type CallFact,
  type CodeFacts,
  type ExportFact,
  type ExportKind,
  type FailureReason,
  type ImportFact,
  type ImportKind,
  type LimitName,
  type ParseErrorFact,
  type ParseLimits,
  type ParseStatus,
  type Range,
  type SymbolFact,
  type SymbolKind,
} from "./types.ts";

const SIGNATURE_MAX = 240;
const CALLEE_MAX = 200;

export function toRange(node: Node): Range {
  const s = node.startPosition;
  const e = node.endPosition;
  return { start: { line: s.row + 1, column: s.column + 1 }, end: { line: e.row + 1, column: e.column + 1 } };
}

export function emptyFacts(
  language: string | null,
  status: ParseStatus,
  reason: FailureReason | null,
  content: string,
  limitsHit: LimitName[] = [],
): CodeFacts {
  return {
    language,
    status,
    reason,
    errors: [],
    symbols: [],
    imports: [],
    exports: [],
    calls: [],
    stats: { bytes: utf8Length(content), lines: countLines(content), nodeCount: 0, errorCount: 0, limitsHit },
  };
}

function oversizedErrorRanges(tree: Tree, maxChildren: number): [Point, Point][] {
  const out: [Point, Point][] = [];
  const cursor = tree.walk();
  try {
    for (;;) {
      const big = cursor.nodeType === "ERROR" && cursor.currentNode.childCount > maxChildren;
      if (big) out.push([cursor.startPosition, cursor.endPosition]);
      if (!big && cursor.gotoFirstChild()) continue;
      while (!cursor.gotoNextSibling()) {
        if (!cursor.gotoParent()) return out;
      }
    }
  } finally {
    cursor.delete();
  }
}

const before = (a: Point, b: Point) => a.row < b.row || (a.row === b.row && a.column < b.column);

function runQuery(loaded: LoadedLanguage, root: Node, skip: [Point, Point][], progressCallback: () => boolean): QueryMatch[] {
  const raw: QueryMatch[] = [];
  if (skip.length === 0) {
    raw.push(...loaded.query.matches(root, { progressCallback }));
  } else {
    let from = root.startPosition;
    for (const [start, end] of [...skip, [root.endPosition, root.endPosition] as [Point, Point]]) {
      if (before(from, start)) raw.push(...loaded.query.matches(root, { startPosition: from, endPosition: start, progressCallback }));
      from = end;
    }
  }
  const seen = new Set<string>();
  return raw.filter((m) => {
    const key = `${m.patternIndex}:${m.captures.map((c) => `${c.name}=${c.node.id}`).join(",")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function collectErrors(root: Node, max: number): { errors: ParseErrorFact[]; count: number } {
  const errors: ParseErrorFact[] = [];
  let count = 0;
  const cursor = root.walk();
  try {
    for (;;) {
      const node = cursor.currentNode;
      let descend = false;
      if (node.isError) {
        count++;
        if (errors.length < max) errors.push({ kind: "error", range: toRange(node) });
      } else if (node.isMissing) {
        count++;
        if (errors.length < max) errors.push({ kind: "missing", range: toRange(node) });
      } else {
        descend = node.hasError;
      }
      if (descend && cursor.gotoFirstChild()) continue;
      for (;;) {
        if (cursor.gotoNextSibling()) break;
        if (!cursor.gotoParent()) return { errors, count };
      }
    }
  } finally {
    cursor.delete();
  }
}

function signatureOf(def: Node, content: string): string | null {
  const body = def.childForFieldName("body") ?? def.childForFieldName("value")?.childForFieldName("body") ?? null;
  let text: string;
  if (body && body.startIndex > def.startIndex) {
    text = content.slice(def.startIndex, body.startIndex);
  } else {
    text = content.slice(def.startIndex, def.endIndex).split("\n")[0] ?? "";
  }
  const flat = collapse(text, SIGNATURE_MAX).replace(/\s*(\{|:|=>)$/, "");
  return flat.length > 0 ? flat : null;
}

interface RawSymbol {
  def: Node;
  nameNode: Node;
  kind: SymbolKind;
  pattern: number;
}

const contains = (outer: Node, inner: Node) => outer.startIndex <= inner.startIndex && inner.endIndex <= outer.endIndex;

export function extractFacts(loaded: LoadedLanguage, content: string, limits: ParseLimits): CodeFacts {
  const { def: lang, parser } = loaded;
  const hooks = lang.hooks ?? {};
  const deadline = performance.now() + limits.timeoutMs;
  let timedOut = false;
  const progressCallback = () => {
    if (performance.now() > deadline) timedOut = true;
    return timedOut;
  };

  parser.reset();
  const tree = parser.parse(content, null, { progressCallback });
  if (!tree) return emptyFacts(lang.id, "failed", "timeout", content, ["timeout"]);

  try {
    const root = tree.rootNode;
    const nodeCount = root.descendantCount;
    if (nodeCount > limits.maxNodes) {
      const facts = emptyFacts(lang.id, "failed", "too_many_nodes", content, ["maxNodes"]);
      facts.stats.nodeCount = nodeCount;
      return facts;
    }

    const limitsHit = new Set<LimitName>();
    const skip = root.hasError ? oversizedErrorRanges(tree, limits.maxErrorChildren) : [];
    if (skip.length > 0) limitsHit.add("oversizedErrorNode");
    const matches = runQuery(loaded, root, skip, progressCallback);

    const rawSymbols = new Map<number, RawSymbol>();
    const rawImports: { node: Node; sourceNode: Node; kind: ImportKind | undefined }[] = [];
    const exportNodes = new Map<number, Node>();
    const rawCalls = new Map<number, { node: Node; callee: Node; object: Node | null }>();

    for (const match of matches) {
      const cap = (name: string) => match.captures.find((c) => c.name === name)?.node ?? null;
      const defCap = match.captures.find((c) => c.name.startsWith("definition."));
      if (defCap) {
        const captured = cap("name");
        const kind = defCap.name.slice("definition.".length) as SymbolKind;
        if (!SYMBOL_KINDS.includes(kind)) continue;
        const named = captured
          ? [{ name: captured, kind }]
          : (hooks.definitions?.(defCap.node, kind) ?? []).filter((d) => SYMBOL_KINDS.includes(d.kind));
        for (const { name: nameNode, kind: namedKind } of named) {
          const existing = rawSymbols.get(nameNode.id);
          if (!existing || match.patternIndex < existing.pattern) {
            rawSymbols.set(nameNode.id, { def: defCap.node, nameNode, kind: namedKind, pattern: match.patternIndex });
          }
        }
        continue;
      }
      const importNode = cap("import");
      const sourceNode = cap("import.source");
      if (importNode && sourceNode) {
        rawImports.push({ node: importNode, sourceNode, kind: match.setProperties?.kind as ImportKind | undefined });
        continue;
      }
      const exportNode = cap("export");
      if (exportNode) {
        exportNodes.set(exportNode.id, exportNode);
        continue;
      }
      const callNode = cap("call");
      const callee = cap("call.callee");
      if (callNode && callee) {
        const object = cap("call.object");
        const prev = rawCalls.get(callNode.id);
        if (!prev || (!prev.object && object)) rawCalls.set(callNode.id, { node: callNode, callee, object });
      }
    }

    // Symbols: source order, outer before inner, so parents always precede children.
    let ordered = [...rawSymbols.values()].sort(
      (a, b) => a.def.startIndex - b.def.startIndex || b.def.endIndex - a.def.endIndex || a.nameNode.startIndex - b.nameNode.startIndex,
    );
    if (ordered.length > limits.maxSymbols) {
      ordered = ordered.slice(0, limits.maxSymbols);
      limitsHit.add("maxSymbols");
    }

    const symbols: SymbolFact[] = [];
    const exportKinds: (Extract<ExportKind, "named" | "default"> | null)[] = [];
    const stack: number[] = [];
    for (let i = 0; i < ordered.length; i++) {
      const raw = ordered[i]!;
      while (stack.length > 0) {
        const top = ordered[stack[stack.length - 1]!]!;
        if (top.def.id !== raw.def.id && contains(top.def, raw.def)) break;
        stack.pop();
      }
      const parentIndex = stack.length > 0 ? stack[stack.length - 1]! : null;
      const parent = parentIndex === null ? null : symbols[parentIndex]!;
      let kind = raw.kind;
      if (kind === "function" && (parent?.kind === "class" || parent?.kind === "interface")) kind = "method";
      kind = hooks.refineKind?.(raw.def, kind) ?? kind;
      const name = unquote(raw.nameNode.text);
      const exportKind = hooks.exportOf?.(raw.def, { name, kind, parent: parent ? { kind: parent.kind, exported: parent.exported } : null }) ?? null;
      symbols.push({ name, kind, parentIndex, range: toRange(raw.def), signature: signatureOf(raw.def, content), exported: exportKind !== null });
      exportKinds.push(exportKind);
      stack.push(i);
    }

    // Imports.
    rawImports.sort((a, b) => a.node.startIndex - b.node.startIndex || a.sourceNode.startIndex - b.sourceNode.startIndex);
    let imports: ImportFact[] = [];
    for (const raw of rawImports) {
      const source = unquote(raw.sourceNode.text).trim();
      if (!source) continue;
      const details = hooks.importDetails?.(raw.node, source) ?? { names: [] };
      imports.push({ source, names: details.names, kind: raw.kind ?? details.kind ?? "static", range: toRange(raw.node) });
    }
    if (imports.length > limits.maxImports) {
      imports = imports.slice(0, limits.maxImports);
      limitsHit.add("maxImports");
    }

    // Exports: exported top-level declarations plus language-specific export statements.
    const exportList: (ExportFact & { at: number })[] = [];
    symbols.forEach((s, i) => {
      const k = exportKinds[i];
      if (s.parentIndex !== null || !k) return;
      exportList.push({ name: k === "default" ? "default" : s.name, kind: k, source: null, symbolIndex: i, range: s.range, at: ordered[i]!.def.startIndex });
    });
    if (hooks.collectExports) {
      const topLevelByName = new Map<string, number>();
      symbols.forEach((s, i) => {
        if (s.parentIndex === null && !topLevelByName.has(s.name)) topLevelByName.set(s.name, i);
      });
      for (const node of [...exportNodes.values()].sort((a, b) => a.startIndex - b.startIndex)) {
        for (const raw of hooks.collectExports(node)) {
          const symbolIndex = raw.localName !== null ? (topLevelByName.get(raw.localName) ?? null) : null;
          if (symbolIndex !== null) symbols[symbolIndex]!.exported = true;
          exportList.push({ name: raw.name, kind: raw.kind, source: raw.source, symbolIndex, range: toRange(raw.node), at: raw.node.startIndex });
        }
      }
    }
    exportList.sort((a, b) => a.at - b.at || a.name.localeCompare(b.name));
    let exports: ExportFact[] = exportList.map(({ name, kind, source, symbolIndex, range }) => ({ name, kind, source, symbolIndex, range }));
    if (exports.length > limits.maxExports) {
      exports = exports.slice(0, limits.maxExports);
      limitsHit.add("maxExports");
    }

    // Calls with their innermost enclosing symbol.
    const callList = [...rawCalls.values()].sort((a, b) => a.node.startIndex - b.node.startIndex || a.node.endIndex - b.node.endIndex);
    let calls: CallFact[] = callList.map(({ node, callee, object }) => ({
      calleeText: collapse(object ? `${object.text}.${callee.text}` : callee.text, CALLEE_MAX),
      enclosingSymbolIndex: enclosingSymbol(ordered, symbols, node),
      range: toRange(node),
    }));
    if (calls.length > limits.maxCalls) {
      calls = calls.slice(0, limits.maxCalls);
      limitsHit.add("maxCalls");
    }

    const { errors, count } = root.hasError ? collectErrors(root, limits.maxErrors) : { errors: [], count: 0 };
    if (count > errors.length) limitsHit.add("maxErrors");
    if (timedOut) limitsHit.add("timeout");

    return {
      language: lang.id,
      status: root.hasError || timedOut ? "partial" : "ok",
      reason: null,
      errors,
      symbols,
      imports,
      exports,
      calls,
      stats: {
        bytes: utf8Length(content),
        lines: countLines(content),
        nodeCount,
        errorCount: count,
        limitsHit: [...limitsHit].sort(),
      },
    };
  } finally {
    tree.delete();
  }
}

function enclosingSymbol(ordered: RawSymbol[], symbols: SymbolFact[], node: Node): number | null {
  // Last symbol starting at or before the call; the innermost container is it or one of its ancestors.
  let lo = 0;
  let hi = ordered.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ordered[mid]!.def.startIndex <= node.startIndex) {
      idx = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  for (let i: number | null = idx >= 0 ? idx : null; i !== null; i = symbols[i]!.parentIndex) {
    if (contains(ordered[i]!.def, node)) return i;
  }
  return null;
}
