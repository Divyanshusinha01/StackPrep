import type { LanguageDefinition } from "../language.ts";
import { c } from "./c.ts";
import { cpp } from "./cpp.ts";
import { go } from "./go.ts";
import { java } from "./java.ts";
import { javascript } from "./javascript.ts";
import { python } from "./python.ts";
import { tsx, typescript } from "./typescript.ts";

export { c, cpp, go, java, javascript, python, tsx, typescript };

/** Languages shipped by default. `.h` is C unless its content selects C++ (see `c.detectContent`). */
export const defaultLanguages: readonly LanguageDefinition[] = [typescript, tsx, javascript, python, java, go, c, cpp];
