import { assert, assertEquals } from "@std/assert";

const coreDir = new URL("./", import.meta.url);

// Built from parts so this file's own fixtures are not read as imports by the scan below.
const FROM = "fr" + "om";
const IMPORT = "imp" + "ort";

/** Module specifiers referenced by static imports, re-exports, side-effect imports and dynamic imports. */
function importSpecifiers(source: string): string[] {
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  return patterns.flatMap((pattern) => [...source.matchAll(pattern)].map((m) => m[1]));
}

/** A dynamic import with a computed specifier cannot be checked, so it is forbidden outright. */
function hasComputedImport(source: string): boolean {
  return /\bimport\s*\(\s*[^"'\s)]/.test(source);
}

/** Core may import only other core files and the Deno standard library. */
function isAllowed(specifier: string, fromFile: URL): boolean {
  if (specifier.startsWith("@std/") || specifier.startsWith("jsr:@std/")) return true;
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return false;
  return new URL(specifier, fromFile).href.startsWith(coreDir.href);
}

function violations(source: string, fromFile: URL): string[] {
  const bad = importSpecifiers(source).filter((s) => !isAllowed(s, fromFile));
  if (hasComputedImport(source)) bad.push("<computed dynamic import>");
  return bad;
}

async function coreFiles(dir: URL): Promise<URL[]> {
  const files: URL[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isDirectory) files.push(...await coreFiles(new URL(`${entry.name}/`, dir)));
    else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) files.push(new URL(entry.name, dir));
  }
  return files;
}

Deno.test("core files import only core and @std", async () => {
  const files = await coreFiles(coreDir);
  assert(files.some((f) => f.href.endsWith("/keys.ts")), "scan did not find core files");
  const found: string[] = [];
  for (const file of files) {
    for (const spec of violations(await Deno.readTextFile(file), file)) {
      found.push(`${file.pathname.slice(coreDir.pathname.length)}: ${spec}`);
    }
  }
  assertEquals(found, []);
});

Deno.test("the import scan catches project, production, package and npm imports", () => {
  const file = new URL("stats.ts", coreDir);
  const source = [
    `${IMPORT} { a } ${FROM} "./keys.ts";`,
    `${IMPORT} type { B } ${FROM} "@std/assert";`,
    `${IMPORT} { c } ${FROM} "../projects/stackprep/project.ts";`,
    `export * ${FROM} "../../supabase/functions/_shared/ai/openai.ts";`,
    `${IMPORT} "@stackprep/shared";`,
    `const z = await ${IMPORT}("npm:zod");`,
    `const m = await ${IMPORT}(path);`,
  ].join("\n");
  assertEquals(violations(source, file), [
    "../projects/stackprep/project.ts",
    "../../supabase/functions/_shared/ai/openai.ts",
    "@stackprep/shared",
    "npm:zod",
    "<computed dynamic import>",
  ]);
});
