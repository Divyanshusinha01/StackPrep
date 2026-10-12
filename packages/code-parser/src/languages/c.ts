import type { LanguageDefinition } from "../language.ts";
import { C_QUERY } from "../queries/c.ts";
import { cFamilyHooks, looksLikeCpp } from "./c-family.ts";

export const c: LanguageDefinition = {
  id: "c",
  extensions: [".c", ".h"],
  grammar: "tree-sitter-c.wasm",
  queries: { facts: C_QUERY },
  hooks: cFamilyHooks,
  detectContent: (content, path) => (/\.h$/i.test(path) && looksLikeCpp(content) ? "cpp" : null),
};
