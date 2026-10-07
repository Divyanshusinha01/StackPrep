import type { CodeFacts } from "../src/index.ts";

export const symbolRows = (facts: CodeFacts) =>
  facts.symbols.map((s) => ({
    name: s.name,
    kind: s.kind,
    parent: s.parentIndex === null ? null : facts.symbols[s.parentIndex]!.name,
    exported: s.exported,
  }));

export const importRows = (facts: CodeFacts) => facts.imports.map((i) => ({ source: i.source, names: i.names, kind: i.kind }));

export const exportRows = (facts: CodeFacts) =>
  facts.exports.map((e) => ({
    name: e.name,
    kind: e.kind,
    source: e.source,
    symbol: e.symbolIndex === null ? null : facts.symbols[e.symbolIndex]!.name,
  }));

export const callRows = (facts: CodeFacts) =>
  facts.calls.map((c) => ({
    callee: c.calleeText,
    in: c.enclosingSymbolIndex === null ? null : facts.symbols[c.enclosingSymbolIndex]!.name,
  }));
