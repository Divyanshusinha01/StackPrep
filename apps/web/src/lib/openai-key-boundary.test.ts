import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const webRoot = fileURLToPath(new URL("../..", import.meta.url));
const srcRoot = join(webRoot, "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const files = sourceFiles(srcRoot).map((path) => ({
  path: relative(webRoot, path).replaceAll("\\", "/"),
  text: readFileSync(path, "utf8"),
}));

function isClientComponent(text: string): boolean {
  let rest = text.trimStart();
  for (;;) {
    if (rest.startsWith("//")) {
      const nl = rest.indexOf("\n");
      if (nl === -1) return false;
      rest = rest.slice(nl + 1).trimStart();
    } else if (rest.startsWith("/*")) {
      const end = rest.indexOf("*/", 2);
      if (end === -1) return false;
      rest = rest.slice(end + 2).trimStart();
    } else {
      return /^["']use client["']/.test(rest);
    }
  }
}

/** Any non-type import of the API helpers or the settings actions. */
const VALUE_IMPORT_OF_KEY_MODULES = /import\s+(?!type\s)[^;]*?from\s+["'](?:@\/lib\/api|[^"']*settings\/actions)["']/;

describe("OpenAI key boundary", () => {
  it("finds client components to check", () => {
    expect(files.filter((f) => isClientComponent(f.text)).length).toBeGreaterThan(0);
  });

  it("keeps the API helpers and the key actions out of every client component", () => {
    const offenders = files
      .filter((f) => isClientComponent(f.text) && VALUE_IMPORT_OF_KEY_MODULES.test(f.text))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("marks the API helpers server-only and the key actions as server actions", () => {
    expect(files.find((f) => f.path === "src/lib/api.ts")?.text.startsWith('import "server-only";')).toBe(true);
    expect(files.find((f) => f.path === "src/app/settings/actions.ts")?.text.startsWith('"use server";')).toBe(true);
  });

  it("never pre-fills the key input or puts the key in a URL", () => {
    const form = files.find((f) => f.path === "src/components/app/openai-key-form.tsx")?.text ?? "";
    expect(form).toMatch(/type="password"/);
    expect(form).toMatch(/autoComplete="off"/);
    expect(form).not.toMatch(/defaultValue|value=\{(?!returnTo)/);

    const actions = files.find((f) => f.path === "src/app/settings/actions.ts")?.text ?? "";
    const redirectArgs = actions.match(/settingsUrl\([^)]*\)|failureUrl\([^)]*\)/g) ?? [];
    expect(redirectArgs.length).toBeGreaterThan(0);
    expect(redirectArgs.join(" ")).not.toMatch(/api_key|parsed/);
  });

  it("never ships an OpenAI secret key in web sources", () => {
    const offenders = files.filter((f) => /sk-[A-Za-z0-9_-]{20,}/.test(f.text)).map((f) => f.path);
    expect(offenders).toEqual([]);
  });
});
