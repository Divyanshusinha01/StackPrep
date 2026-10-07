import type { LanguageDefinition } from "../language.ts";
import { go } from "./go.ts";
import { java } from "./java.ts";
import { javascript } from "./javascript.ts";
import { python } from "./python.ts";
import { tsx, typescript } from "./typescript.ts";

export { go, java, javascript, python, tsx, typescript };

/** Languages shipped by default. C and C++ are intentionally not included yet. */
export const defaultLanguages: readonly LanguageDefinition[] = [typescript, tsx, javascript, python, java, go];
