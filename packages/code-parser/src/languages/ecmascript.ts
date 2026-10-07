import type { Node } from "web-tree-sitter";
import type { LanguageHooks, RawExport } from "../language.ts";
import { unquote } from "../text.ts";

function hasChildType(node: Node, type: string): boolean {
  return node.children.some((c) => c?.type === type);
}

function specifierNames(clause: Node): { name: string; alias: string | null; node: Node }[] {
  const out: { name: string; alias: string | null; node: Node }[] = [];
  for (const spec of clause.namedChildren) {
    if (!spec) continue;
    const name = spec.childForFieldName("name");
    if (!name) continue;
    out.push({ name: unquote(name.text), alias: spec.childForFieldName("alias") ? unquote(spec.childForFieldName("alias")!.text) : null, node: spec });
  }
  return out;
}

export const ecmascriptHooks: LanguageHooks = {
  refineKind(def, kind) {
    if (kind === "variable" && def.parent?.type === "lexical_declaration" && def.parent.firstChild?.type === "const") {
      return "constant";
    }
    return kind;
  },

  exportOf(def, ctx) {
    if (ctx.parent) return null;
    for (let p = def.parent; p && p.type !== "program"; p = p.parent) {
      if (p.type === "export_statement") return hasChildType(p, "default") ? "default" : "named";
    }
    return null;
  },

  importDetails(node) {
    if (node.type === "import_statement") {
      const names: string[] = [];
      const clause = node.namedChildren.find((c) => c?.type === "import_clause");
      for (const part of clause?.namedChildren ?? []) {
        if (!part) continue;
        if (part.type === "identifier") names.push("default");
        else if (part.type === "namespace_import") names.push("*");
        else if (part.type === "named_imports") names.push(...specifierNames(part).map((s) => s.name));
      }
      return { names, kind: hasChildType(node, "type") ? "type" : "static" };
    }
    if (node.type === "export_statement") {
      const clause = node.namedChildren.find((c) => c?.type === "export_clause");
      return { names: clause ? specifierNames(clause).map((s) => s.name) : ["*"] };
    }
    return { names: [] };
  },

  collectExports(node) {
    const out: RawExport[] = [];
    const sourceNode = node.childForFieldName("source");
    const source = sourceNode ? unquote(sourceNode.text) : null;
    const clause = node.namedChildren.find((c) => c?.type === "export_clause");

    if (source !== null) {
      if (clause) {
        for (const s of specifierNames(clause)) {
          out.push({ name: s.alias ?? s.name, kind: "reexport", source, localName: null, node: s.node });
        }
      } else {
        const ns = node.namedChildren.find((c) => c?.type === "namespace_export");
        const alias = ns?.namedChildren.find((c) => c !== null);
        out.push(alias
          ? { name: unquote(alias.text), kind: "reexport", source, localName: null, node: ns! }
          : { name: "*", kind: "all", source, localName: null, node });
      }
      return out;
    }

    if (clause) {
      for (const s of specifierNames(clause)) {
        const exported = s.alias ?? s.name;
        out.push({ name: exported, kind: exported === "default" ? "default" : "named", source: null, localName: s.name, node: s.node });
      }
      return out;
    }

    // `export default <expression>`; declarations are classified through exportOf.
    if (hasChildType(node, "default") && !node.childForFieldName("declaration")) {
      const value = node.childForFieldName("value");
      out.push({ name: "default", kind: "default", source: null, localName: value?.type === "identifier" ? value.text : null, node });
    }
    return out;
  },
};
