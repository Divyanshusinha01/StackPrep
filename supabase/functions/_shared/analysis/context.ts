/**
 * Builds compact repository context from scanned paths and fetched files. Raw source never
 * leaves this module: only manifest-derived facts, symbol names, and short scrubbed excerpts.
 */
import type { LimitHit, TreeStats } from "./filter.ts";
import { scrubDeep, scrubSecrets } from "./scrub.ts";

export const ANALYZER_VERSION = "lightweight-1";

export const CONTEXT_LIMITS = {
  maxRowContentChars: 2_000,
  maxRowStructuredBytes: 8_192,
  maxTotalBytes: 64 * 1024,
  maxExcerptChars: 300,
  maxHeadingChars: 80,
  maxListItems: 60,
} as const;

export type FileRole = "readme" | "manifest" | "config" | "ci" | "source";

export interface FileFacts {
  path: string;
  role: FileRole;
  facts: Record<string, unknown>;
}

export type MemoryKind =
  | "architecture_summary"
  | "technologies"
  | "modules"
  | "key_files"
  | "dependencies"
  | "configuration";

export interface MemoryRow {
  kind: MemoryKind;
  content: string;
  structured: Record<string, unknown>;
  metadata: Record<string, unknown>;
  token_count: number;
}

// Extraction -------------------------------------------------------------------

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function cap<T>(items: T[], max: number = CONTEXT_LIMITS.maxListItems): T[] {
  return items.slice(0, max);
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function parseJsonc(text: string): Record<string, unknown> | null {
  return parseJson(text) ??
    parseJson(text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_m, str) => str ?? "")
      .replace(/,(\s*[}\]])/g, "$1"));
}

function stringRecord(value: unknown): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => typeof v === "string")
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return Object.fromEntries(cap(entries)) as Record<string, string>;
}

function objectKeys(value: unknown): string[] {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? cap(Object.keys(value).sort())
    : [];
}

function tomlSection(text: string, header: string): string {
  const start = text.search(new RegExp(`^\\[${header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]\\s*$`, "m"));
  if (start === -1) {
    return "";
  }
  const rest = text.slice(start).split("\n").slice(1);
  const end = rest.findIndex((line) => /^\[/.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

function tomlKeys(section: string): string[] {
  return cap([...section.matchAll(/^([A-Za-z0-9_.-]+)\s*=/gm)].map((m) => m[1]));
}

function extractManifest(name: string, raw: string): Record<string, unknown> {
  switch (name) {
    case "package.json": {
      const pkg = parseJson(raw);
      if (!pkg) {
        return { parse_error: true };
      }
      return {
        ecosystem: "npm",
        name: typeof pkg.name === "string" ? pkg.name : null,
        module_type: typeof pkg.type === "string" ? pkg.type : null,
        workspaces: Array.isArray(pkg.workspaces) || (typeof pkg.workspaces === "object" && pkg.workspaces !== null),
        engines: stringRecord(pkg.engines),
        scripts: objectKeys(pkg.scripts),
        dependencies: stringRecord(pkg.dependencies),
        dev_dependencies: stringRecord(pkg.devDependencies),
      };
    }
    case "deno.json":
    case "deno.jsonc": {
      const cfg = parseJsonc(raw);
      if (!cfg) {
        return { parse_error: true };
      }
      return { ecosystem: "deno", dependencies: stringRecord(cfg.imports), tasks: objectKeys(cfg.tasks) };
    }
    case "composer.json": {
      const cfg = parseJson(raw);
      return cfg
        ? { ecosystem: "composer", dependencies: stringRecord(cfg.require), dev_dependencies: stringRecord(cfg["require-dev"]) }
        : { parse_error: true };
    }
    case "requirements.txt": {
      const deps = raw.split("\n")
        .map((line) => line.replace(/#.*$/, "").trim())
        .filter((line) => line && !line.startsWith("-") && !line.includes("://"))
        .map((line) => line.match(/^([A-Za-z0-9_.\-[\]]+)\s*(.*)$/))
        .filter((m): m is RegExpMatchArray => m !== null)
        .map((m) => [m[1].toLowerCase(), m[2].trim()] as const);
      return { ecosystem: "pypi", dependencies: Object.fromEntries(cap(deps)) };
    }
    case "pyproject.toml": {
      const project = tomlSection(raw, "project");
      const listed = project.match(/^dependencies\s*=\s*\[([\s\S]*?)\]/m)?.[1] ?? "";
      const pep621 = [...listed.matchAll(/["']([A-Za-z0-9_.\-[\]]+)\s*([^"']*)["']/g)]
        .map((m) => [m[1].toLowerCase(), m[2].trim()] as const);
      const poetry = tomlKeys(tomlSection(raw, "tool.poetry.dependencies"))
        .filter((k) => k !== "python")
        .map((k) => [k.toLowerCase(), ""] as const);
      return {
        ecosystem: "pypi",
        name: project.match(/^name\s*=\s*["']([^"']+)["']/m)?.[1] ?? null,
        dependencies: Object.fromEntries(cap([...pep621, ...poetry])),
      };
    }
    case "go.mod": {
      const requires = [...raw.matchAll(/^\s*(?:require\s+)?([a-z0-9.\-]+\.[a-z]{2,}\/[^\s]+)\s+(v[^\s]+)/gm)]
        .map((m) => [m[1], m[2]] as const);
      return {
        ecosystem: "go",
        module: raw.match(/^module\s+(\S+)/m)?.[1] ?? null,
        go_version: raw.match(/^go\s+(\S+)/m)?.[1] ?? null,
        dependencies: Object.fromEntries(cap(requires)),
      };
    }
    case "Cargo.toml":
      return {
        ecosystem: "cargo",
        name: tomlSection(raw, "package").match(/^name\s*=\s*"([^"]+)"/m)?.[1] ?? null,
        dependencies: Object.fromEntries(tomlKeys(tomlSection(raw, "dependencies")).map((k) => [k, ""])),
        dev_dependencies: Object.fromEntries(tomlKeys(tomlSection(raw, "dev-dependencies")).map((k) => [k, ""])),
      };
    case "Gemfile":
      return {
        ecosystem: "rubygems",
        dependencies: Object.fromEntries(cap([...raw.matchAll(/^\s*gem\s+["']([^"']+)["']/gm)].map((m) => [m[1], ""]))),
      };
    case "pom.xml":
      return {
        ecosystem: "maven",
        dependencies: Object.fromEntries(
          cap([...raw.matchAll(/<artifactId>([^<]+)<\/artifactId>/g)].map((m) => [m[1].trim(), ""])),
        ),
      };
    case "build.gradle":
    case "build.gradle.kts":
      return {
        ecosystem: "gradle",
        dependencies: Object.fromEntries(
          cap([...raw.matchAll(/(?:implementation|api|compileOnly|runtimeOnly)\s*\(?\s*["']([^:"']+:[^:"']+)/g)]
            .map((m) => [m[1], ""])),
        ),
      };
    default:
      return { ecosystem: "other" };
  }
}

function extractReadme(text: string): Record<string, unknown> {
  const lines = text.split("\n");
  const headings = lines
    .map((line) => line.match(/^#{1,3}\s+(.+?)\s*#*$/)?.[1])
    .filter((h): h is string => Boolean(h))
    .map((h) => clip(h.replace(/[`*_[\]]/g, ""), CONTEXT_LIMITS.maxHeadingChars));
  const paragraph = text
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .find((block) => block && !/^(#|!\[|\[!\[|<|```|\|)/.test(block));
  return {
    title: headings[0] ?? null,
    headings: cap(headings, 20),
    excerpt: paragraph ? clip(paragraph, CONTEXT_LIMITS.maxExcerptChars) : null,
  };
}

function extractConfig(name: string, raw: string, text: string): Record<string, unknown> {
  if (/^tsconfig/.test(name)) {
    const opts = parseJsonc(raw)?.compilerOptions as Record<string, unknown> | undefined;
    const pick = (k: string) => (typeof opts?.[k] === "string" || typeof opts?.[k] === "boolean" ? opts[k] : null);
    return {
      kind: "typescript",
      target: pick("target"),
      module: pick("module"),
      module_resolution: pick("moduleResolution"),
      strict: pick("strict"),
      jsx: pick("jsx"),
      path_aliases: objectKeys(opts?.paths),
    };
  }
  if (/^Dockerfile/.test(name)) {
    return {
      kind: "docker",
      base_images: cap([...text.matchAll(/^\s*FROM\s+(?:--\S+\s+)*(\S+)/gim)].map((m) => m[1].split("@")[0]), 10),
      exposed_ports: cap([...text.matchAll(/^\s*EXPOSE\s+(.+)$/gim)].flatMap((m) => m[1].trim().split(/\s+/)), 10),
      multi_stage: (text.match(/^\s*FROM\s/gim) ?? []).length > 1,
    };
  }
  if (/compose/.test(name)) {
    const services = text.match(/^services:\s*\n((?:[ \t]+.*\n?|\s*\n)*)/m)?.[1] ?? "";
    return {
      kind: "compose",
      services: cap([...services.matchAll(/^ {2}([A-Za-z0-9_.-]+):/gm)].map((m) => m[1]), 20),
      images: cap([...text.matchAll(/^\s+image:\s*["']?([^\s"']+)/gm)].map((m) => m[1]), 20),
    };
  }
  if (name === "schema.prisma") {
    return {
      kind: "prisma",
      provider: text.match(/datasource\s+\w+\s*{[^}]*provider\s*=\s*"([^"]+)"/)?.[1] ?? null,
      models: cap([...text.matchAll(/^model\s+(\w+)/gm)].map((m) => m[1])),
    };
  }
  if (name === "config.toml") {
    return {
      kind: "toml",
      sections: cap([...text.matchAll(/^\[([^\]]+)\]/gm)].map((m) => m[1]), 30),
    };
  }
  return { kind: "config" };
}

function extractWorkflow(text: string): Record<string, unknown> {
  const jobs = text.match(/^jobs:\s*\n((?:[ \t]+.*\n?|\s*\n)*)/m)?.[1] ?? "";
  return {
    name: text.match(/^name:\s*["']?(.+?)["']?\s*$/m)?.[1] ?? null,
    jobs: cap([...jobs.matchAll(/^ {2}([A-Za-z0-9_-]+):/gm)].map((m) => m[1]), 20),
    actions: cap([...new Set([...text.matchAll(/uses:\s*["']?([^@\s"']+)/g)].map((m) => m[1]))].sort(), 20),
  };
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript",
  mts: "TypeScript",
  cts: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  py: "Python",
  go: "Go",
  rs: "Rust",
  rb: "Ruby",
  java: "Java",
  kt: "Kotlin",
  kts: "Kotlin",
  scala: "Scala",
  cs: "C#",
  php: "PHP",
  ex: "Elixir",
  exs: "Elixir",
  swift: "Swift",
  dart: "Dart",
  vue: "Vue",
  svelte: "Svelte",
  astro: "Astro",
  sql: "SQL",
  c: "C",
  h: "C",
  cc: "C++",
  cpp: "C++",
  hpp: "C++",
  css: "CSS",
  scss: "SCSS",
  html: "HTML",
  sh: "Shell",
};

function extractSource(path: string, text: string): Record<string, unknown> {
  const ext = basename(path).split(".").pop()?.toLowerCase() ?? "";
  let imports: string[] = [];
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs", "vue", "svelte", "astro"].includes(ext)) {
    imports = [...text.matchAll(/(?:import\s[^'"]*?from\s*|import\s*\(?\s*|require\(\s*)["']([^"']+)["']/g)]
      .map((m) => m[1]);
  } else if (ext === "py") {
    imports = [...text.matchAll(/^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm)].map((m) => m[1] ?? m[2]);
  } else if (ext === "go") {
    const block = text.match(/import\s*\(([\s\S]*?)\)/)?.[1] ?? "";
    imports = [...block.matchAll(/"([^"]+)"/g), ...text.matchAll(/^import\s+(?:\w+\s+)?"([^"]+)"/gm)].map((m) => m[1]);
  } else if (ext === "rs") {
    imports = [...text.matchAll(/^\s*use\s+([\w:]+)/gm)].map((m) => m[1]);
  }
  const external = [...new Set(imports.filter((i) => !i.startsWith(".") && !i.startsWith("/")))].sort();
  const exports = [
    ...text.matchAll(
      /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm,
    ),
    ...(ext === "py" ? text.matchAll(/^(?:def|class)\s+([A-Za-z_]\w*)/gm) : []),
    ...(ext === "go" ? text.matchAll(/^func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)/gm) : []),
  ].map((m) => m[1]);
  const tables = ext === "sql"
    ? [...text.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?([\w."]+)/gi)].map((m) => m[1].replaceAll('"', ""))
    : [];
  return {
    language: LANGUAGE_BY_EXTENSION[ext] ?? null,
    lines: text.split("\n").length,
    external_imports: cap(external, 30),
    relative_imports: imports.filter((i) => i.startsWith(".")).length,
    exports: cap([...new Set(exports)], 30),
    ...(tables.length ? { tables: cap(tables, 40) } : {}),
  };
}

const MANIFEST_NAMES = new Set([
  "package.json",
  "deno.json",
  "deno.jsonc",
  "requirements.txt",
  "pyproject.toml",
  "go.mod",
  "Cargo.toml",
  "Gemfile",
  "composer.json",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
]);

const CONFIG_NAME =
  /^(tsconfig(\.[\w-]+)?\.json|Dockerfile(\.[\w-]+)?|(docker-)?compose(\.[\w-]+)?\.ya?ml|schema\.prisma|config\.toml|[\w-]+\.config\.\w+|\.eslintrc(\.\w+)?|(vercel|netlify|fly|render|turbo|nx|pnpm-workspace)\.(json|toml|ya?ml)|Makefile|Procfile)$/;

export function fileRole(path: string): FileRole {
  const name = basename(path);
  if (/^readme(\.\w+)?$/i.test(name)) {
    return "readme";
  }
  if (MANIFEST_NAMES.has(name)) {
    return "manifest";
  }
  if (path.startsWith(".github/workflows/")) {
    return "ci";
  }
  if (CONFIG_NAME.test(name)) {
    return "config";
  }
  return "source";
}

/**
 * Structured parsing uses the raw text in memory; free-text extraction uses scrubbed text, and
 * every extracted string is scrubbed again before it is returned.
 */
export function extractFileFacts(path: string, raw: string): FileFacts {
  const role = fileRole(path);
  const name = basename(path);
  const text = scrubSecrets(raw);
  let facts: Record<string, unknown>;
  switch (role) {
    case "readme":
      facts = extractReadme(text);
      break;
    case "manifest":
      facts = extractManifest(name, raw);
      break;
    case "ci":
      facts = extractWorkflow(text);
      break;
    case "config":
      facts = extractConfig(name, raw, text);
      break;
    default:
      facts = extractSource(path, text);
  }
  return { path, role, facts: scrubDeep(facts) };
}

// Technology detection ---------------------------------------------------------

const FRAMEWORKS: Record<string, string> = {
  next: "Next.js",
  react: "React",
  "react-native": "React Native",
  expo: "Expo",
  vue: "Vue",
  nuxt: "Nuxt",
  svelte: "Svelte",
  "@sveltejs/kit": "SvelteKit",
  "@angular/core": "Angular",
  astro: "Astro",
  "@remix-run/react": "Remix",
  "solid-js": "Solid",
  electron: "Electron",
  express: "Express",
  fastify: "Fastify",
  "@nestjs/core": "NestJS",
  hono: "Hono",
  koa: "Koa",
  "@trpc/server": "tRPC",
  graphql: "GraphQL",
  "@apollo/server": "Apollo Server",
  "@supabase/supabase-js": "Supabase",
  "@supabase/ssr": "Supabase",
  "@prisma/client": "Prisma",
  prisma: "Prisma",
  "drizzle-orm": "Drizzle ORM",
  typeorm: "TypeORM",
  sequelize: "Sequelize",
  mongoose: "MongoDB (Mongoose)",
  pg: "PostgreSQL",
  postgres: "PostgreSQL",
  mysql2: "MySQL",
  redis: "Redis",
  ioredis: "Redis",
  "socket.io": "Socket.IO",
  inngest: "Inngest",
  bullmq: "BullMQ",
  stripe: "Stripe",
  openai: "OpenAI",
  "@anthropic-ai/sdk": "Anthropic",
  ai: "Vercel AI SDK",
  zod: "Zod",
  tailwindcss: "Tailwind CSS",
  "@tanstack/react-query": "TanStack Query",
  redux: "Redux",
  "@reduxjs/toolkit": "Redux",
  zustand: "Zustand",
  "framer-motion": "Framer Motion",
  motion: "Motion",
  "@sentry/nextjs": "Sentry",
  "@sentry/node": "Sentry",
  vite: "Vite",
  webpack: "webpack",
  vitest: "Vitest",
  jest: "Jest",
  mocha: "Mocha",
  "@playwright/test": "Playwright",
  cypress: "Cypress",
  "@testing-library/react": "Testing Library",
  typescript: "TypeScript",
  eslint: "ESLint",
  django: "Django",
  flask: "Flask",
  fastapi: "FastAPI",
  sqlalchemy: "SQLAlchemy",
  pydantic: "Pydantic",
  celery: "Celery",
  pytest: "pytest",
  pandas: "pandas",
  numpy: "NumPy",
  torch: "PyTorch",
  tensorflow: "TensorFlow",
  rails: "Ruby on Rails",
  sinatra: "Sinatra",
  rspec: "RSpec",
  "github.com/gin-gonic/gin": "Gin",
  "github.com/labstack/echo/v4": "Echo",
  "github.com/gofiber/fiber/v2": "Fiber",
  "gorm.io/gorm": "GORM",
  "actix-web": "Actix Web",
  axum: "Axum",
  tokio: "Tokio",
  rocket: "Rocket",
  diesel: "Diesel",
  serde: "Serde",
  "laravel/framework": "Laravel",
  "symfony/framework-bundle": "Symfony",
  "spring-boot-starter-web": "Spring Boot",
  "spring-boot-starter": "Spring Boot",
};

function dependencyName(spec: string): string {
  return spec.replace(/^(npm:|jsr:)/, "").replace(/(?<=.)@[^/]*$/, "");
}

interface Dependencies {
  manifest: string;
  ecosystem: string;
  runtime: Record<string, string>;
  dev: Record<string, string>;
}

function collectDependencies(files: FileFacts[]): Dependencies[] {
  return files
    .filter((f) => f.role === "manifest" && !f.facts.parse_error)
    .map((f) => ({
      manifest: f.path,
      ecosystem: String(f.facts.ecosystem ?? "other"),
      runtime: (f.facts.dependencies ?? {}) as Record<string, string>,
      dev: (f.facts.dev_dependencies ?? {}) as Record<string, string>,
    }));
}

function detectFrameworks(deps: Dependencies[]): string[] {
  const found = new Set<string>();
  for (const d of deps) {
    for (const name of [...Object.keys(d.runtime), ...Object.entries(d.runtime).map(([, v]) => v), ...Object.keys(d.dev)]) {
      const label = FRAMEWORKS[dependencyName(name)] ?? FRAMEWORKS[name];
      if (label) {
        found.add(label);
      }
    }
  }
  return [...found].sort();
}

function detectLanguages(stats: TreeStats): { language: string; files: number }[] {
  const counts = new Map<string, number>();
  for (const [ext, n] of Object.entries(stats.extensions)) {
    const language = LANGUAGE_BY_EXTENSION[ext];
    if (language) {
      counts.set(language, (counts.get(language) ?? 0) + n);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 12)
    .map(([language, files]) => ({ language, files }));
}

function detectRuntimes(files: FileFacts[], stats: TreeStats): string[] {
  const runtimes = new Set<string>();
  const names = new Set(files.map((f) => basename(f.path)));
  for (const f of files) {
    const engines = f.facts.engines as Record<string, string> | undefined;
    if (engines?.node) {
      runtimes.add(`Node.js ${engines.node}`);
    }
    if (f.facts.go_version) {
      runtimes.add(`Go ${f.facts.go_version}`);
    }
  }
  if (names.has("package.json") && ![...runtimes].some((r) => r.startsWith("Node.js"))) {
    runtimes.add("Node.js");
  }
  if (names.has("deno.json") || names.has("deno.jsonc") || stats.lockfiles.includes("deno.lock")) {
    runtimes.add("Deno");
  }
  if (stats.lockfiles.some((l) => l.startsWith("bun.lock"))) {
    runtimes.add("Bun");
  }
  if (names.has("requirements.txt") || names.has("pyproject.toml")) {
    runtimes.add("Python");
  }
  return [...runtimes].sort();
}

function packageManager(stats: TreeStats): string | null {
  const byLockfile: [string, string][] = [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
    ["bun.lockb", "bun"],
    ["bun.lock", "bun"],
    ["poetry.lock", "poetry"],
    ["uv.lock", "uv"],
  ];
  return byLockfile.find(([file]) => stats.lockfiles.includes(file))?.[1] ?? null;
}

// Context assembly ------------------------------------------------------------

export interface ContextInput {
  commitSha: string;
  stats: TreeStats;
  limitsHit: LimitHit[];
  files: FileFacts[];
  /** Selected files that could not be fetched or decoded. */
  skippedFiles: number;
}

const MODULE_ROLES: [RegExp, string][] = [
  [/^(apps?|web|frontend|client|ui)$/, "application / frontend"],
  [/^(packages|libs?|shared|common)$/, "shared packages"],
  [/^(server|backend|api|services?)$/, "backend / API"],
  [/^supabase$/, "Supabase (database migrations, edge functions)"],
  [/^(prisma|db|database|migrations)$/, "database schema / migrations"],
  [/^(src)$/, "application source"],
  [/^(app|pages)$/, "routes / pages"],
  [/^(components)$/, "UI components"],
  [/^(tests?|__tests__|e2e|spec|cypress)$/, "tests"],
  [/^(docs?)$/, "documentation"],
  [/^(scripts|tools|bin)$/, "tooling scripts"],
  [/^(infra|deploy|k8s|terraform|helm|\.github)$/, "infrastructure / CI"],
  [/^(public|static|assets)$/, "static assets"],
];

function moduleRole(name: string): string | null {
  return MODULE_ROLES.find(([pattern]) => pattern.test(name))?.[1] ?? null;
}

function observations(input: ContextInput, frameworks: string[]): string[] {
  const { stats, files } = input;
  const out: string[] = [];
  const manifests = files.filter((f) => basename(f.path) === "package.json");
  const isMonorepo = manifests.length > 1 || manifests.some((f) => f.facts.workspaces === true) ||
    files.some((f) => /pnpm-workspace|turbo\.json|nx\.json|lerna\.json/.test(f.path));
  if (isMonorepo) {
    out.push("Monorepo with multiple packages/workspaces.");
  }
  const has = (label: string) => frameworks.includes(label);
  if (has("Next.js")) {
    const appRouter = files.some((f) => /(^|\/)app\/(.+\/)?(page|layout|route)\.(t|j)sx?$/.test(f.path));
    out.push(appRouter ? "Next.js App Router frontend." : "Next.js frontend.");
  } else if (has("React")) {
    out.push("React frontend.");
  }
  if (stats.top_level.some((t) => t.name === "supabase") || has("Supabase")) {
    out.push("Uses Supabase for backend services (Postgres/Auth/Edge Functions).");
  }
  for (const label of ["Express", "Fastify", "NestJS", "Hono", "Django", "Flask", "FastAPI", "Ruby on Rails", "Gin", "Axum", "Spring Boot", "Laravel"]) {
    if (has(label)) {
      out.push(`${label} server.`);
    }
  }
  const orm = ["Prisma", "Drizzle ORM", "TypeORM", "Sequelize", "SQLAlchemy", "GORM", "Diesel"].filter(has);
  if (orm.length) {
    out.push(`Data access via ${orm.join(", ")}.`);
  }
  const sqlTables = files.flatMap((f) => (f.facts.tables as string[] | undefined) ?? []);
  if (sqlTables.length) {
    out.push(`SQL schema defines tables such as ${cap([...new Set(sqlTables)], 8).join(", ")}.`);
  }
  if (has("Inngest") || has("BullMQ") || has("Celery")) {
    out.push("Background job processing.");
  }
  if (has("OpenAI") || has("Anthropic") || has("Vercel AI SDK")) {
    out.push("Integrates an LLM provider.");
  }
  out.push(stats.has_tests ? "Has automated tests." : "No test files detected.");
  if (stats.has_ci) {
    out.push("CI workflows configured.");
  }
  if (stats.has_docker) {
    out.push("Containerized with Docker.");
  }
  if (input.limitsHit.length) {
    out.push(`Partial analysis (limits reached: ${input.limitsHit.join(", ")}).`);
  }
  return out;
}

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/** Halves the longest array (or record) until the value fits. Deterministic. */
export function fitStructured(value: Record<string, unknown>, maxBytes: number): Record<string, unknown> {
  let current = structuredClone(value);
  for (let i = 0; i < 64 && jsonBytes(current) > maxBytes; i++) {
    let longest: { holder: Record<string, unknown> | unknown[]; key: string | number; size: number } | null = null;
    const visit = (holder: Record<string, unknown> | unknown[], key: string | number, v: unknown) => {
      if (Array.isArray(v) || (v !== null && typeof v === "object")) {
        const size = Array.isArray(v) ? v.length : Object.keys(v).length;
        if (size > 1 && (!longest || size > longest.size)) {
          longest = { holder, key, size };
        }
        for (const [k, child] of Object.entries(v as object)) {
          visit(v as Record<string, unknown>, Array.isArray(v) ? Number(k) : k, child);
        }
      }
    };
    for (const [k, v] of Object.entries(current)) {
      visit(current, k, v);
    }
    if (!longest) {
      return { truncated: true };
    }
    const { holder, key } = longest as { holder: Record<string, unknown>; key: string };
    const target = holder[key];
    holder[key] = Array.isArray(target)
      ? target.slice(0, Math.floor(target.length / 2))
      : Object.fromEntries(Object.entries(target as object).slice(0, Math.floor(Object.keys(target as object).length / 2)));
    current = { ...current, truncated: true };
  }
  return jsonBytes(current) > maxBytes ? { truncated: true } : current;
}

function row(
  kind: MemoryKind,
  content: string,
  structured: Record<string, unknown>,
  metadata: Record<string, unknown>,
): MemoryRow {
  const safeContent = clip(scrubSecrets(content), CONTEXT_LIMITS.maxRowContentChars);
  return {
    kind,
    content: safeContent,
    structured: fitStructured(scrubDeep(structured), CONTEXT_LIMITS.maxRowStructuredBytes),
    metadata,
    token_count: Math.ceil(safeContent.length / 4),
  };
}

export function buildRepositoryContext(input: ContextInput): MemoryRow[] {
  const { stats, files, commitSha } = input;
  const deps = collectDependencies(files);
  const frameworks = detectFrameworks(deps);
  const languages = detectLanguages(stats);
  const runtimes = detectRuntimes(files, stats);
  const pm = packageManager(stats);
  const notes = observations(input, frameworks);
  const readme = files.find((f) => f.role === "readme" && !f.path.includes("/"));
  const meta = { analyzer_version: ANALYZER_VERSION, commit_sha: commitSha };

  const modules = stats.top_level
    .filter((t) => t.type === "dir")
    .map((t) => ({ name: t.name, files: t.files, role: moduleRole(t.name) }));

  const keyFiles = files.map((f) => ({
    path: f.path,
    role: f.role,
    ...(f.role === "source"
      ? { language: f.facts.language, exports: cap((f.facts.exports as string[]) ?? [], 10) }
      : {}),
  }));

  const configuration = files
    .filter((f) => f.role === "config" || f.role === "ci")
    .map((f) => ({ path: f.path, ...f.facts }));

  const primaryLanguages = languages.slice(0, 3).map((l) => l.language);
  const summary = [
    readme?.facts.title ? `${readme.facts.title}.` : null,
    typeof readme?.facts.excerpt === "string" ? readme.facts.excerpt : null,
    primaryLanguages.length ? `Primarily ${primaryLanguages.join(", ")}.` : null,
    frameworks.length ? `Built with ${cap(frameworks, 10).join(", ")}.` : null,
    ...notes,
  ].filter(Boolean).join(" ");

  const rows: MemoryRow[] = [
    row("architecture_summary", summary || "No architecture signals detected.", {
      observations: notes,
      readme: readme ? { title: readme.facts.title, headings: readme.facts.headings } : null,
    }, {
      ...meta,
      total_entries: stats.total_entries,
      files: stats.files,
      included_files: stats.included_files,
      analyzed_files: files.length,
      skipped_files: input.skippedFiles,
      excluded: stats.excluded,
      limits_hit: input.limitsHit,
    }),
    row(
      "technologies",
      [
        languages.length ? `Languages: ${languages.map((l) => l.language).join(", ")}.` : null,
        frameworks.length ? `Frameworks and libraries: ${frameworks.join(", ")}.` : null,
        runtimes.length ? `Runtimes: ${runtimes.join(", ")}.` : null,
        pm ? `Package manager: ${pm}.` : null,
      ].filter(Boolean).join(" ") || "No technologies detected.",
      { languages, frameworks, runtimes, package_manager: pm },
      meta,
    ),
    row(
      "modules",
      modules.length
        ? modules.map((m) => `${m.name}/ (${m.files} files${m.role ? `, ${m.role}` : ""})`).join("; ")
        : "Flat repository with no top-level directories.",
      { modules },
      meta,
    ),
    row(
      "key_files",
      keyFiles.length ? keyFiles.map((f) => `${f.path} [${f.role}]`).join("; ") : "No key files analyzed.",
      { files: keyFiles },
      meta,
    ),
    row(
      "dependencies",
      deps.length
        ? deps.map((d) =>
          `${d.manifest} (${d.ecosystem}): ${cap(Object.keys(d.runtime), 25).join(", ") || "no runtime dependencies"}`
        ).join("; ")
        : "No dependency manifests found.",
      { manifests: deps },
      meta,
    ),
    row(
      "configuration",
      configuration.length ? configuration.map((c) => c.path).join("; ") : "No configuration files analyzed.",
      { files: configuration, has_ci: stats.has_ci, has_docker: stats.has_docker, has_tests: stats.has_tests },
      meta,
    ),
  ];

  for (let i = 0; i < 8 && jsonBytes(rows) > CONTEXT_LIMITS.maxTotalBytes; i++) {
    const largest = rows.reduce((a, b) => (jsonBytes(b.structured) > jsonBytes(a.structured) ? b : a));
    largest.structured = fitStructured(largest.structured, Math.floor(jsonBytes(largest.structured) / 2));
  }
  return rows;
}
