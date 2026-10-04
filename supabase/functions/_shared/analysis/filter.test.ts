import { assert, assertEquals } from "@std/assert";
import { type AnalysisLimits, classifyPath, isSensitivePath, relevanceScore, scanTree, type TreeEntry } from "./filter.ts";

const sha = (n: number) => n.toString(16).padStart(40, "0");
const blob = (path: string, size = 100, n = 1): TreeEntry => ({ path, type: "blob", sha: sha(n), size });

Deno.test("excluded directories, binaries, lockfiles, and generated files are never considered", () => {
  const cases: [string, string][] = [
    ["node_modules/react/index.js", "excluded_dir"],
    ["apps/web/.next/server/page.js", "excluded_dir"],
    ["dist/index.js", "excluded_dir"],
    ["vendor/github.com/x/y.go", "excluded_dir"],
    ["coverage/lcov.info", "excluded_dir"],
    ["public/logo.png", "binary"],
    ["fonts/Inter.woff2", "binary"],
    ["assets/demo.mp4", "binary"],
    ["pnpm-lock.yaml", "lockfile"],
    ["apps/web/package-lock.json", "lockfile"],
    ["go.sum", "lockfile"],
    ["public/vendor.min.js", "generated"],
    ["packages/shared/src/database.types.ts", "generated"],
    ["api/user.pb.go", "generated"],
  ];
  for (const [path, reason] of cases) {
    assertEquals(classifyPath(path), reason, path);
  }
  for (const path of ["src/index.ts", "README.md", "package.json", "supabase/migrations/001.sql"]) {
    assertEquals(classifyPath(path), null, path);
  }
});

Deno.test("sensitive files are excluded before anything else", () => {
  for (
    const path of [
      ".env",
      ".env.local",
      "apps/web/.env.production",
      "config/prod.env",
      "certs/server.pem",
      "keys/app.key",
      "id_rsa",
      "home/.ssh/config",
      ".aws/credentials",
      "credentials.json",
      "service-account.json",
      "config/secrets.yml",
      ".npmrc",
      "infra/terraform.tfstate",
      "node_modules/.env",
    ]
  ) {
    assert(isSensitivePath(path), path);
    assertEquals(classifyPath(path), "sensitive", path);
  }
  for (const path of ["src/env.ts", "packages/shared/src/env.test.ts", "docs/environment.md", "src/keyboard.ts"]) {
    assert(!isSensitivePath(path), path);
  }
});

Deno.test("relevance favors READMEs, manifests, configs, and entrypoints over deep or test files", () => {
  assert(relevanceScore("README.md") > relevanceScore("package.json"));
  assert(relevanceScore("package.json") > relevanceScore("tsconfig.json"));
  assert(relevanceScore("tsconfig.json") > relevanceScore("src/index.ts"));
  assert(relevanceScore("src/index.ts") > relevanceScore("misc/helpers/deep/util.ts"));
  assert(relevanceScore("src/app/page.tsx") > relevanceScore("src/foo.test.ts"));
  assertEquals(relevanceScore("docs/diagram.txt"), 0);
  assert(relevanceScore(".github/workflows/ci.yml") > 0);
  assert(relevanceScore("Dockerfile") > 0);
});

Deno.test("scanTree summarizes the tree and selects files deterministically", () => {
  const entries: TreeEntry[] = [
    { path: "src", type: "tree", sha: sha(9) },
    blob("src/index.ts", 200, 2),
    blob("README.md", 300, 1),
    blob("package.json", 100, 3),
    blob("pnpm-lock.yaml", 5000, 4),
    blob(".env", 50, 5),
    blob("node_modules/x/index.js", 10, 6),
    blob("public/logo.png", 1000, 7),
    blob("src/index.test.ts", 50, 8),
    blob(".github/workflows/ci.yml", 80, 10),
    blob("Dockerfile", 40, 11),
  ];
  const scan = scanTree(entries, false);
  assertEquals(scan.selected.map((f) => f.path), [
    "README.md",
    "package.json",
    "Dockerfile",
    ".github/workflows/ci.yml",
    "src/index.ts",
    "src/index.test.ts",
  ]);
  assertEquals(scan.stats.files, 10);
  assertEquals(scan.stats.included_files, 6);
  assertEquals(scan.stats.excluded, { excluded_dir: 1, binary: 1, lockfile: 1, generated: 0, sensitive: 1 });
  assertEquals(scan.stats.lockfiles, ["pnpm-lock.yaml"]);
  assert(scan.stats.has_tests && scan.stats.has_ci && scan.stats.has_docker);
  assertEquals(scan.limits_hit, []);
  assert(!scan.selected.some((f) => f.path === ".env"));

  const shuffled = scanTree([...entries].reverse(), false);
  assertEquals(shuffled, scan);
});

Deno.test("scanTree enforces file, byte, and tree-size limits and reports which were hit", () => {
  const limits: AnalysisLimits = { maxTreeEntries: 50, maxFilesFetched: 3, maxFileBytes: 1000, maxTotalBytes: 1500 };
  const entries = Array.from({ length: 10 }, (_, i) => blob(`src/file${i}.ts`, 400, i));
  entries.push(blob("src/huge.ts", 5000, 99));

  const scan = scanTree(entries, true, limits);
  assertEquals(scan.selected.length, 3);
  assert(scan.selected.every((f) => f.size <= limits.maxFileBytes));
  assert(scan.selected.reduce((n, f) => n + f.size, 0) <= limits.maxTotalBytes);
  assert(scan.limits_hit.includes("tree_truncated"));
  assert(scan.limits_hit.includes("max_files_fetched"));

  const bytes = scanTree(entries, false, { ...limits, maxFilesFetched: 10 });
  assertEquals(bytes.selected.length, 3);
  assert(bytes.limits_hit.includes("max_total_bytes"));

  const many = Array.from({ length: 80 }, (_, i) => blob(`f${String(i).padStart(2, "0")}.ts`, 1, i));
  const capped = scanTree(many, false, limits);
  assertEquals(capped.stats.files, 50);
  assert(capped.limits_hit.includes("max_tree_entries"));
});
