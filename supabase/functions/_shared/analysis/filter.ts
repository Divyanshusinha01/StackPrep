/** Deterministic, content-free classification of repository paths for lightweight analysis. */

export interface TreeEntry {
  path: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size?: number;
}

export interface AnalysisLimits {
  /** Tree entries beyond this are ignored (GitHub's own recursive-tree cap is ~100k). */
  maxTreeEntries: number;
  maxFilesFetched: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export const DEFAULT_ANALYSIS_LIMITS: AnalysisLimits = {
  maxTreeEntries: 20_000,
  maxFilesFetched: 40,
  maxFileBytes: 64 * 1024,
  maxTotalBytes: 512 * 1024,
};

export type ExclusionReason = "excluded_dir" | "binary" | "lockfile" | "generated" | "sensitive";

export type LimitHit = "tree_truncated" | "max_tree_entries" | "max_files_fetched" | "max_total_bytes";

const EXCLUDED_DIRS = new Set([
  "node_modules",
  "bower_components",
  "jspm_packages",
  "vendor",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".vercel",
  ".netlify",
  ".cache",
  ".parcel-cache",
  ".gradle",
  ".idea",
  ".vscode",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".tox",
  ".venv",
  "venv",
  "env",
  ".terraform",
  "Pods",
  "DerivedData",
  "tmp",
  ".temp",
]);

const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "icns", "tif", "tiff", "psd", "heic",
  "mp3", "wav", "ogg", "flac", "m4a", "aac", "mp4", "mov", "avi", "mkv", "webm",
  "woff", "woff2", "ttf", "otf", "eot",
  "zip", "gz", "tgz", "bz2", "xz", "7z", "rar", "tar", "jar", "war", "ear",
  "exe", "dll", "so", "dylib", "a", "o", "obj", "class", "pyc", "pyo", "wasm", "bin", "dat",
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "sqlite", "sqlite3", "db", "parquet",
  "glb", "gltf", "fbx", "blend", "map",
]);

const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "bun.lock",
  "deno.lock",
  "composer.lock",
  "Gemfile.lock",
  "Cargo.lock",
  "poetry.lock",
  "Pipfile.lock",
  "uv.lock",
  "go.sum",
  "mix.lock",
  "pubspec.lock",
  "packages.lock.json",
  "flake.lock",
]);

const GENERATED_PATTERNS = [
  /\.min\.(js|css|mjs)$/i,
  /[.-]bundle\.(js|mjs)$/i,
  /\.chunk\.(js|css)$/i,
  /\.generated\.\w+$/i,
  /\.g\.dart$/i,
  /\.pb\.go$/i,
  /_pb2(_grpc)?\.py$/i,
  /(^|\/)database\.types\.ts$/i,
  /\.snap$/i,
];

const SENSITIVE_NAMES = new Set([
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".htpasswd",
  ".git-credentials",
  "credentials",
  "credentials.json",
  "service-account.json",
  "secrets.json",
  "secrets.yml",
  "secrets.yaml",
  ".dockercfg",
  "terraform.tfstate",
  "terraform.tfvars",
]);

const SENSITIVE_EXTENSIONS = new Set(["pem", "key", "p12", "pfx", "jks", "keystore", "crt", "cer", "der", "asc", "gpg", "kdbx", "tfstate", "tfvars"]);

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function isSensitivePath(path: string): boolean {
  const name = basename(path);
  const lower = name.toLowerCase();
  return lower === ".env" || lower.startsWith(".env.") || lower.endsWith(".env") ||
    SENSITIVE_NAMES.has(lower) || SENSITIVE_EXTENSIONS.has(extension(lower)) ||
    /^id_[a-z0-9]+$/.test(lower) || /(^|[._-])secrets?([._-]|$)/.test(lower) ||
    path.split("/").some((segment) => segment === ".ssh" || segment === ".aws" || segment === ".gnupg");
}

/** Why a path is never read, or null when it may be considered. */
export function classifyPath(path: string): ExclusionReason | null {
  if (isSensitivePath(path)) {
    return "sensitive";
  }
  const segments = path.split("/");
  if (segments.slice(0, -1).some((segment) => EXCLUDED_DIRS.has(segment))) {
    return "excluded_dir";
  }
  const name = segments[segments.length - 1];
  if (LOCKFILES.has(name)) {
    return "lockfile";
  }
  if (BINARY_EXTENSIONS.has(extension(name))) {
    return "binary";
  }
  if (GENERATED_PATTERNS.some((pattern) => pattern.test(path))) {
    return "generated";
  }
  return null;
}

const MANIFESTS = new Set([
  "package.json",
  "deno.json",
  "deno.jsonc",
  "requirements.txt",
  "pyproject.toml",
  "Pipfile",
  "setup.py",
  "setup.cfg",
  "go.mod",
  "Cargo.toml",
  "Gemfile",
  "composer.json",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "mix.exs",
  "pubspec.yaml",
]);

const CONFIG_PATTERNS = [
  /^tsconfig(\.[\w-]+)?\.json$/,
  /^(next|vite|nuxt|svelte|astro|remix|webpack|rollup|tailwind|postcss|vitest|jest|playwright|eslint|babel)\.config\.\w+$/,
  /^\.eslintrc(\.\w+)?$/,
  /^(docker-compose|compose)(\.[\w-]+)?\.ya?ml$/,
  /^Dockerfile(\.[\w-]+)?$/,
  /^(vercel|netlify|fly|render|app|firebase|turbo|nx|lerna|pnpm-workspace)\.(json|toml|ya?ml)$/,
  /^config\.toml$/,
  /^Makefile$/,
  /^Procfile$/,
  /^schema\.prisma$/,
];

const SOURCE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "rs", "rb", "java", "kt", "kts", "scala", "cs",
  "php", "ex", "exs", "swift", "dart", "vue", "svelte", "astro", "sql", "c", "cc", "cpp", "h", "hpp",
]);

const IMPORTANT_DIRS = new Set([
  "src", "app", "pages", "api", "server", "lib", "routes", "supabase", "functions", "prisma",
  "migrations", "db", "services", "handlers", "controllers", "models", "core", "packages",
]);

const ENTRYPOINT_NAMES = /^(index|main|app|server|mod|handler|route|page|layout|middleware|proxy|schema)\.\w+$/;

/** Higher is more useful for understanding architecture; 0 means not worth fetching. */
export function relevanceScore(path: string): number {
  const segments = path.split("/");
  const name = segments[segments.length - 1];
  const depth = segments.length - 1;
  const depthPenalty = Math.min(depth, 6) * 2;

  if (/^readme(\.\w+)?$/i.test(name)) {
    return depth === 0 ? 100 : 40 - depthPenalty;
  }
  if (MANIFESTS.has(name)) {
    return (depth === 0 ? 95 : 70) - depthPenalty;
  }
  if (CONFIG_PATTERNS.some((pattern) => pattern.test(name))) {
    return (depth === 0 ? 75 : 55) - depthPenalty;
  }
  if (path.startsWith(".github/workflows/") && /\.ya?ml$/.test(name)) {
    return 45;
  }
  if (!SOURCE_EXTENSIONS.has(extension(name))) {
    return 0;
  }
  if (/(^|\/)(__tests__|tests?|spec|e2e)\//.test(path) || /\.(test|spec)\.\w+$/.test(name)) {
    return 5;
  }
  let score = 10;
  if (segments.slice(0, -1).some((segment) => IMPORTANT_DIRS.has(segment))) {
    score += 15;
  }
  if (ENTRYPOINT_NAMES.test(name)) {
    score += 15;
  }
  if (segments.includes("migrations") || extension(name) === "sql") {
    score += 5;
  }
  return Math.max(1, score - depthPenalty);
}

export interface SelectedFile {
  path: string;
  sha: string;
  size: number;
}

export interface TreeStats {
  total_entries: number;
  files: number;
  included_files: number;
  excluded: Record<ExclusionReason, number>;
  extensions: Record<string, number>;
  top_level: { name: string; type: "dir" | "file"; files: number }[];
  has_tests: boolean;
  has_ci: boolean;
  has_docker: boolean;
  lockfiles: string[];
}

export interface TreeScan {
  stats: TreeStats;
  selected: SelectedFile[];
  limits_hit: LimitHit[];
}

const MAX_EXTENSION_KEYS = 30;
const MAX_TOP_LEVEL = 40;

/** Summarizes the tree and picks which files to fetch. Same input always yields the same output. */
export function scanTree(
  entries: readonly TreeEntry[],
  truncated: boolean,
  limits: AnalysisLimits = DEFAULT_ANALYSIS_LIMITS,
): TreeScan {
  const limitsHit = new Set<LimitHit>();
  if (truncated) {
    limitsHit.add("tree_truncated");
  }
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (sorted.length > limits.maxTreeEntries) {
    limitsHit.add("max_tree_entries");
  }
  const considered = sorted.slice(0, limits.maxTreeEntries);

  const excluded: Record<ExclusionReason, number> = {
    excluded_dir: 0,
    binary: 0,
    lockfile: 0,
    generated: 0,
    sensitive: 0,
  };
  const extensionCounts = new Map<string, number>();
  const topLevel = new Map<string, { type: "dir" | "file"; files: number }>();
  const lockfiles = new Set<string>();
  const candidates: { file: SelectedFile; score: number }[] = [];
  let files = 0;
  let includedFiles = 0;
  let hasTests = false;
  let hasCi = false;
  let hasDocker = false;

  for (const entry of considered) {
    if (entry.type !== "blob") {
      continue;
    }
    files++;
    const reason = classifyPath(entry.path);
    if (reason !== null) {
      excluded[reason]++;
      if (reason === "lockfile") {
        lockfiles.add(basename(entry.path));
      }
      continue;
    }
    includedFiles++;

    const slash = entry.path.indexOf("/");
    const top = slash === -1 ? entry.path : entry.path.slice(0, slash);
    const current = topLevel.get(top) ?? { type: slash === -1 ? "file" : "dir", files: 0 };
    current.files++;
    topLevel.set(top, current);

    const ext = extension(basename(entry.path));
    if (ext) {
      extensionCounts.set(ext, (extensionCounts.get(ext) ?? 0) + 1);
    }
    hasTests ||= /(^|\/)(__tests__|tests?|spec|e2e)\//.test(entry.path) || /\.(test|spec)\.\w+$/.test(entry.path);
    hasCi ||= entry.path.startsWith(".github/workflows/") || entry.path === ".gitlab-ci.yml" ||
      entry.path.startsWith(".circleci/");
    hasDocker ||= /(^|\/)(Dockerfile[\w.-]*|(docker-)?compose[\w.-]*\.ya?ml)$/.test(entry.path);

    const score = relevanceScore(entry.path);
    if (score > 0) {
      candidates.push({ file: { path: entry.path, sha: entry.sha, size: entry.size ?? 0 }, score });
    }
  }

  candidates.sort((a, b) => b.score - a.score || (a.file.path < b.file.path ? -1 : 1));
  const selected: SelectedFile[] = [];
  let totalBytes = 0;
  for (const { file } of candidates) {
    if (file.size > limits.maxFileBytes) {
      continue;
    }
    if (selected.length >= limits.maxFilesFetched) {
      limitsHit.add("max_files_fetched");
      break;
    }
    if (totalBytes + file.size > limits.maxTotalBytes) {
      limitsHit.add("max_total_bytes");
      continue;
    }
    totalBytes += file.size;
    selected.push(file);
  }

  const extensions = Object.fromEntries(
    [...extensionCounts.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, MAX_EXTENSION_KEYS),
  );
  const top_level = [...topLevel.entries()]
    .sort((a, b) => b[1].files - a[1].files || (a[0] < b[0] ? -1 : 1))
    .slice(0, MAX_TOP_LEVEL)
    .map(([name, v]) => ({ name, ...v }));

  return {
    stats: {
      total_entries: entries.length,
      files,
      included_files: includedFiles,
      excluded,
      extensions,
      top_level,
      has_tests: hasTests,
      has_ci: hasCi,
      has_docker: hasDocker,
      lockfiles: [...lockfiles].sort(),
    },
    selected,
    limits_hit: [...limitsHit].sort(),
  };
}
