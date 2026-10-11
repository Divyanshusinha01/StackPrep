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

const USE_CLIENT = /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*["']use client["']/;
const IMPORTS_ADMIN = /from\s+["'](?:@\/lib\/admin|(?:\.{1,2}\/)+(?:lib\/)?admin)["']/;

describe("admin boundary", () => {
  it("finds client components to check", () => {
    expect(files.filter((f) => USE_CLIENT.test(f.text)).length).toBeGreaterThan(0);
  });

  it("keeps the admin module out of every client component", () => {
    const offenders = files.filter((f) => USE_CLIENT.test(f.text) && IMPORTS_ADMIN.test(f.text)).map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("marks the admin module server-only", () => {
    const admin = files.find((f) => f.path === "src/lib/admin.ts");
    expect(admin?.text.startsWith('import "server-only";')).toBe(true);
  });

  it("never references the service-role key in the web app", () => {
    const sources = [...files, { path: ".env.example", text: readFileSync(join(webRoot, ".env.example"), "utf8") }];
    const offenders = sources.filter((f) => /SERVICE_ROLE/i.test(f.text)).map((f) => f.path);
    expect(offenders).toEqual([]);
  });
});
