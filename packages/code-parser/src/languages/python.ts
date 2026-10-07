import type { LanguageDefinition } from "../language.ts";
import { PYTHON_QUERY } from "../queries/python.ts";

export const python: LanguageDefinition = {
  id: "python",
  extensions: [".py", ".pyi"],
  grammar: "tree-sitter-python.wasm",
  queries: { facts: PYTHON_QUERY },
  hooks: {
    refineKind(def, kind) {
      if (kind !== "variable") return kind;
      const name = def.childForFieldName("left")?.text ?? "";
      return /^[A-Z][A-Z0-9_]*$/.test(name) ? "constant" : kind;
    },
    exportOf(_def, { name, parent }) {
      if (name.startsWith("_")) return null;
      if (!parent) return "named";
      return parent.kind === "class" && parent.exported ? "named" : null;
    },
    importDetails(node) {
      if (node.type !== "import_from_statement") return { names: [] };
      const names: string[] = [];
      if (node.namedChildren.some((c) => c?.type === "wildcard_import")) names.push("*");
      for (const n of node.childrenForFieldName("name")) {
        if (!n) continue;
        names.push(n.type === "aliased_import" ? (n.childForFieldName("name")?.text ?? n.text) : n.text);
      }
      return { names };
    },
  },
};
