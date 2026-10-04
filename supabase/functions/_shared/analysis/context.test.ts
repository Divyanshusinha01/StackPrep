import { assert, assertEquals } from "@std/assert";
import {
  ANALYZER_VERSION,
  buildRepositoryContext,
  CONTEXT_LIMITS,
  extractFileFacts,
  type FileFacts,
  fitStructured,
} from "./context.ts";
import { scanTree, type TreeEntry } from "./filter.ts";

const SHA = "a".repeat(40);
const blob = (path: string): TreeEntry => ({ path, type: "blob", sha: "b".repeat(40), size: 10 });
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

const PACKAGE_JSON = JSON.stringify({
  name: "acme-web",
  type: "module",
  engines: { node: ">=24" },
  scripts: { dev: "next dev", deploy: "TOKEN=abc123secretvalue vercel deploy" },
  dependencies: { next: "^16.0.0", react: "^19.0.0", "@supabase/supabase-js": "^2.0.0", jsonwebtoken: "^9.0.0" },
  devDependencies: { vitest: "^3.0.0", typescript: "^6.0.0" },
});

const SOURCE = `import { createClient } from "@supabase/supabase-js";
import { helper } from "./helper";
const SERVICE_KEY = "sk_live_${"x".repeat(24)}";
export async function handler(req: Request) {
  // a long body that must never be stored verbatim
  return new Response("unique-source-marker-123");
}
export const config = {};
`;

const README = `# Acme Web

Acme Web is an interview practice app. Connect with password=hunter2hunter2 for the demo.

## Architecture

## Development
`;

function sampleFiles(): FileFacts[] {
  return [
    extractFileFacts("README.md", README),
    extractFileFacts("package.json", PACKAGE_JSON),
    extractFileFacts("tsconfig.json", '{ // comment\n "compilerOptions": { "strict": true, "target": "ES2022", "paths": { "@/*": ["./src/*"] } } }'),
    extractFileFacts("Dockerfile", "FROM node:24-alpine AS build\nFROM nginx:1.27\nEXPOSE 80 443\n"),
    extractFileFacts("supabase/migrations/001.sql", "create table public.workspaces (id uuid);\ncreate table if not exists jobs (id uuid);"),
    extractFileFacts("src/app/api/route.ts", SOURCE),
    extractFileFacts(".github/workflows/ci.yml", "name: CI\non: [push]\njobs:\n  test:\n    steps:\n      - uses: actions/checkout@v4\n"),
  ];
}

Deno.test("extractFileFacts derives manifest facts without script commands", () => {
  const pkg = extractFileFacts("package.json", PACKAGE_JSON);
  assertEquals(pkg.role, "manifest");
  assertEquals(pkg.facts.name, "acme-web");
  assertEquals(pkg.facts.scripts, ["deploy", "dev"]);
  assertEquals((pkg.facts.dependencies as Record<string, string>).jsonwebtoken, "^9.0.0");
  assert(!JSON.stringify(pkg).includes("abc123secretvalue"));
});

Deno.test("extractFileFacts keeps only symbol names and imports from source", () => {
  const src = extractFileFacts("src/app/api/route.ts", SOURCE);
  assertEquals(src.role, "source");
  assertEquals(src.facts.external_imports, ["@supabase/supabase-js"]);
  assertEquals(src.facts.relative_imports, 1);
  assertEquals(src.facts.exports, ["handler", "config"]);
  const serialized = JSON.stringify(src);
  assert(!serialized.includes("unique-source-marker-123"));
  assert(!serialized.includes("sk_live_"));
});

Deno.test("extractFileFacts parses other ecosystems and config files", () => {
  assertEquals(
    extractFileFacts("requirements.txt", "Django==5.0\n# comment\n-r base.txt\ngit+https://user:pw@host/x.git\nfastapi>=0.110").facts
      .dependencies,
    { django: "==5.0", fastapi: ">=0.110" },
  );
  const gomod = extractFileFacts("go.mod", "module github.com/acme/api\n\ngo 1.23\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.10.0\n)\n");
  assertEquals(gomod.facts.module, "github.com/acme/api");
  assertEquals(gomod.facts.dependencies, { "github.com/gin-gonic/gin": "v1.10.0" });
  const docker = extractFileFacts("Dockerfile", "FROM node:24-alpine\nFROM nginx@sha256:abc\nEXPOSE 80\n");
  assertEquals(docker.facts.base_images, ["node:24-alpine", "nginx"]);
  assertEquals(docker.facts.multi_stage, true);
  assertEquals(extractFileFacts("tsconfig.json", '{"compilerOptions":{"strict":true}}').facts.strict, true);
  assertEquals(extractFileFacts("package.json", "{not json").facts.parse_error, true);
});

Deno.test("README excerpts are short and scrubbed", () => {
  const readme = extractFileFacts("README.md", README + "x".repeat(5000));
  assertEquals(readme.facts.title, "Acme Web");
  assertEquals(readme.facts.headings, ["Acme Web", "Architecture", "Development"]);
  const excerpt = readme.facts.excerpt as string;
  assert(excerpt.length <= CONTEXT_LIMITS.maxExcerptChars);
  assert(!excerpt.includes("hunter2hunter2"));
});

Deno.test("buildRepositoryContext produces one row per kind with detected technologies", () => {
  const scan = scanTree(
    [
      blob("README.md"),
      blob("package.json"),
      blob("pnpm-lock.yaml"),
      blob("src/app/api/route.ts"),
      blob("src/app/page.test.tsx"),
      blob("supabase/migrations/001.sql"),
      blob(".github/workflows/ci.yml"),
      blob("Dockerfile"),
    ],
    false,
  );
  const rows = buildRepositoryContext({
    commitSha: SHA,
    stats: scan.stats,
    limitsHit: scan.limits_hit,
    files: sampleFiles(),
    skippedFiles: 1,
  });
  assertEquals(rows.map((r) => r.kind), [
    "architecture_summary",
    "technologies",
    "modules",
    "key_files",
    "dependencies",
    "configuration",
  ]);
  const tech = rows.find((r) => r.kind === "technologies")!;
  for (const label of ["Next.js", "React", "Supabase", "Vitest", "TypeScript"]) {
    assert((tech.structured.frameworks as string[]).includes(label), label);
  }
  assertEquals(tech.structured.package_manager, "pnpm");
  assert((tech.structured.runtimes as string[]).includes("Node.js >=24"));

  const summary = rows[0];
  assert(summary.content.startsWith("Acme Web."));
  assert(summary.content.includes("workspaces"));
  assertEquals(summary.metadata.analyzer_version, ANALYZER_VERSION);
  assertEquals(summary.metadata.commit_sha, SHA);
  assertEquals(summary.metadata.skipped_files, 1);
  for (const row of rows) {
    assertEquals(row.metadata.commit_sha, SHA);
    assertEquals(row.token_count, Math.ceil(row.content.length / 4));
  }
});

Deno.test("buildRepositoryContext enforces size caps and never stores source or secrets", () => {
  const files: FileFacts[] = Array.from({ length: 40 }, (_, i) =>
    extractFileFacts(`src/module${i}/index.ts`, SOURCE + Array.from({ length: 50 }, (_, j) => `export const symbol_${i}_${j} = ${j};`).join("\n"))
  );
  const deps = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`dep-${i}`, `^${i}.0.0`]));
  files.push(extractFileFacts("package.json", JSON.stringify({ dependencies: deps })));
  files.push(...sampleFiles());
  const scan = scanTree(files.map((f) => blob(f.path)), true);

  const rows = buildRepositoryContext({ commitSha: SHA, stats: scan.stats, limitsHit: scan.limits_hit, files, skippedFiles: 0 });
  for (const row of rows) {
    assert(row.content.length <= CONTEXT_LIMITS.maxRowContentChars, `${row.kind} content too long`);
    assert(bytes(row.structured) <= CONTEXT_LIMITS.maxRowStructuredBytes, `${row.kind} structured too large`);
  }
  assert(bytes(rows) <= CONTEXT_LIMITS.maxTotalBytes);
  const serialized = JSON.stringify(rows);
  assert(!serialized.includes("unique-source-marker-123"));
  assert(!serialized.includes("hunter2hunter2"));
  assert(!serialized.includes("sk_live_"));
  assert(rows[0].content.includes("Partial analysis"));
});

Deno.test("buildRepositoryContext is deterministic and handles an empty repository", () => {
  const scan = scanTree([], false);
  const input = { commitSha: SHA, stats: scan.stats, limitsHit: scan.limits_hit, files: [], skippedFiles: 0 };
  const rows = buildRepositoryContext(input);
  assertEquals(rows.length, 6);
  assertEquals(buildRepositoryContext(input), rows);
  assert(rows.every((r) => r.content.length > 0));
});

Deno.test("fitStructured shrinks the largest collections until the value fits", () => {
  const value = { items: Array.from({ length: 1000 }, (_, i) => `item-${i}`), small: [1, 2] };
  const fitted = fitStructured(value, 2000);
  assert(bytes(fitted) <= 2000);
  assertEquals(fitted.truncated, true);
  assertEquals(fitted.small, [1, 2]);
  assertEquals(fitStructured({ a: 1 }, 100), { a: 1 });
});
