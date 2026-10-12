import type { LanguageDefinition } from "../language.ts";
import { CPP_QUERY } from "../queries/cpp.ts";
import { cFamilyHooks } from "./c-family.ts";

export const cpp: LanguageDefinition = {
  id: "cpp",
  extensions: [".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx", ".ipp"],
  grammar: "tree-sitter-cpp.wasm",
  queries: { facts: CPP_QUERY },
  hooks: cFamilyHooks,
};
