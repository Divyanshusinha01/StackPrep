import type { LanguageDefinition } from "../language.ts";
import { JAVASCRIPT_QUERY } from "../queries/ecmascript.ts";
import { ecmascriptHooks } from "./ecmascript.ts";

export const javascript: LanguageDefinition = {
  id: "javascript",
  extensions: [".js", ".jsx", ".mjs", ".cjs"],
  grammar: "tree-sitter-javascript.wasm",
  queries: { facts: JAVASCRIPT_QUERY },
  hooks: ecmascriptHooks,
};
