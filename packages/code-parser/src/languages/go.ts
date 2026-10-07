import type { LanguageDefinition } from "../language.ts";
import { GO_QUERY } from "../queries/go.ts";

export const go: LanguageDefinition = {
  id: "go",
  extensions: [".go"],
  grammar: "tree-sitter-go.wasm",
  queries: { facts: GO_QUERY },
  hooks: {
    exportOf(_def, { name }) {
      return /^\p{Lu}/u.test(name) ? "named" : null;
    },
    importDetails(node) {
      const alias = node.childForFieldName("name");
      return { names: alias ? [alias.text] : [] };
    },
  },
};
