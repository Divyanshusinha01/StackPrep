import type { LanguageDefinition } from "../language.ts";
import { TYPESCRIPT_QUERY } from "../queries/ecmascript.ts";
import { ecmascriptHooks } from "./ecmascript.ts";

export const typescript: LanguageDefinition = {
  id: "typescript",
  extensions: [".ts", ".mts", ".cts"],
  grammar: "tree-sitter-typescript.wasm",
  queries: { facts: TYPESCRIPT_QUERY },
  hooks: ecmascriptHooks,
};

export const tsx: LanguageDefinition = {
  id: "tsx",
  extensions: [".tsx"],
  grammar: "tree-sitter-tsx.wasm",
  queries: { facts: TYPESCRIPT_QUERY },
  hooks: ecmascriptHooks,
};
