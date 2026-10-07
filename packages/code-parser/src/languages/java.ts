import type { Node } from "web-tree-sitter";
import type { LanguageDefinition } from "../language.ts";
import { JAVA_QUERY } from "../queries/java.ts";

function modifiers(def: Node): Set<string> {
  const mods = def.namedChildren.find((c) => c?.type === "modifiers");
  return new Set((mods?.children ?? []).flatMap((c) => (c ? [c.type] : [])));
}

export const java: LanguageDefinition = {
  id: "java",
  extensions: [".java"],
  grammar: "tree-sitter-java.wasm",
  queries: { facts: JAVA_QUERY },
  hooks: {
    refineKind(def, kind) {
      if (kind !== "variable") return kind;
      const mods = modifiers(def);
      return mods.has("static") && mods.has("final") ? "constant" : kind;
    },
    exportOf(def, { parent }) {
      // Interface members are implicitly public.
      if (parent?.kind === "interface") return parent.exported ? "named" : null;
      if (!modifiers(def).has("public")) return null;
      return !parent || parent.exported ? "named" : null;
    },
    importDetails(node, source) {
      if (node.namedChildren.some((c) => c?.type === "asterisk")) return { names: ["*"] };
      const last = source.split(".").pop() ?? source;
      return { names: [last] };
    },
  },
};
