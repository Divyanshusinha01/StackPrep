import type { Node } from "web-tree-sitter";
import type { LanguageHooks } from "../language.ts";

function hasStorageClass(def: Node, name: string): boolean {
  return def.namedChildren.some((c) => c?.type === "storage_class_specifier" && c.text === name);
}

/**
 * False for anything in an anonymous namespace or block scope, and for `static` declarations outside
 * classes (a `static` member has class scope, not internal linkage).
 */
function linkageVisible(def: Node, member: boolean): boolean {
  if (!member && hasStorageClass(def, "static")) return false;
  for (let n = def.parent; n; n = n.parent) {
    if (n.type === "compound_statement") return false;
    if (n.type === "namespace_definition" && !n.childForFieldName("name")) return false;
  }
  return true;
}

/** Access of a class member: the nearest preceding access specifier, else the class key's default. */
function memberAccess(def: Node): string {
  const member = def.parent?.type === "template_declaration" ? def.parent : def;
  for (let n = member.previousNamedSibling; n; n = n.previousNamedSibling) {
    if (n.type === "access_specifier") return n.text.replace(/\s*:$/, "");
  }
  return member.parent?.parent?.type === "class_specifier" ? "private" : "public";
}

const CONST_QUALIFIERS = new Set(["const", "constexpr"]);
const NAME_TYPES = new Set(["identifier", "field_identifier", "type_identifier", "destructor_name", "operator_name"]);

/**
 * Follows a declarator chain to its name. It declares a function when the innermost function
 * declarator wraps the name directly (through qualifiers only): `int *f()` is a function,
 * `int (*f)()` is a function pointer.
 */
function declaredName(declarator: Node | null): { name: Node; isFunction: boolean } | null {
  let isFunction = false;
  for (let d = declarator; d;) {
    if (NAME_TYPES.has(d.type)) return { name: d, isFunction };
    switch (d.type) {
      case "function_declarator":
        isFunction = true;
        d = d.childForFieldName("declarator");
        break;
      case "qualified_identifier":
      case "template_function":
        d = d.childForFieldName("name");
        break;
      case "init_declarator":
      case "attributed_declarator":
        d = d.childForFieldName("declarator");
        break;
      case "pointer_declarator":
      case "array_declarator":
        isFunction = false;
        d = d.childForFieldName("declarator");
        break;
      case "reference_declarator":
      case "parenthesized_declarator":
        isFunction = false;
        d = d.namedChildren.find((c) => c !== null && !c.type.endsWith("qualifier")) ?? null;
        break;
      default:
        return null;
    }
  }
  return null;
}

function inBlock(def: Node): boolean {
  for (let n = def.parent; n; n = n.parent) {
    if (n.type === "compound_statement") return true;
  }
  return false;
}

export const cFamilyHooks: LanguageHooks = {
  definitions(def, kind) {
    if (inBlock(def)) return [];
    const names = def.childrenForFieldName("declarator").flatMap((d) => {
      const found = declaredName(d);
      return found ? [found] : [];
    });
    switch (def.type) {
      case "type_definition":
        return names.map(({ name }) => ({ name, kind: "type" }));
      case "declaration": {
        const membersOnly = def.parent?.type === "field_declaration_list" ||
          (def.parent?.type === "template_declaration" && def.parent.parent?.type === "field_declaration_list");
        return names
          .filter((n) => n.isFunction || !membersOnly)
          .map(({ name, isFunction }) => ({ name, kind: isFunction ? "function" : kind }));
      }
      default:
        // function_definition and field_declaration: only function declarators name a symbol.
        return names.filter((n) => n.isFunction).slice(0, 1).map(({ name }) => ({ name, kind: "function" }));
    }
  },
  refineKind(def, kind) {
    if (kind !== "variable") return kind;
    const isConst = def.namedChildren.some((c) => c?.type === "type_qualifier" && CONST_QUALIFIERS.has(c.text));
    const pointer = def.childrenForFieldName("declarator").some((d) =>
      d?.type === "pointer_declarator" || d?.childForFieldName("declarator")?.type === "pointer_declarator"
    );
    return isConst && !pointer ? "constant" : kind;
  },
  exportOf(def, { parent }) {
    const member = parent?.kind === "class";
    if (!linkageVisible(def, member)) return null;
    if (!parent) return "named";
    if (member) return parent.exported && memberAccess(def) === "public" ? "named" : null;
    return parent.exported ? "named" : null;
  },
};

/** Strips comments and string/char literals so markers inside them are ignored. */
function codeOnly(content: string): string {
  return content.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g, " ");
}

const CPP_MARKERS = [
  /\bclass\s+[A-Za-z_]\w*\s*(?:final\s*)?[:{;]/,
  /\bnamespace\b\s*[A-Za-z_\w:]*\s*\{/,
  /\btemplate\s*</,
  /\b(?:public|private|protected)\s*:/,
  /\busing\s+namespace\b/,
  /[A-Za-z_\w>]\s*::\s*~?[A-Za-z_]/,
];

/** True when header text uses C++-only syntax. `extern "C++"` counts; `extern "C"` guards do not. */
export function looksLikeCpp(content: string): boolean {
  if (/\bextern\s+"C\+\+"/.test(content)) return true;
  const code = codeOnly(content);
  return CPP_MARKERS.some((re) => re.test(code));
}
