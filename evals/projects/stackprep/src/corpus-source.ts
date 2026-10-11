/** Corpus identities, pin specs and file loading. No parser or production imports, so pinning stays cheap. */
import type { PinSpec } from "../../../core/types.ts";

export const MANIFEST_FORMAT = 1;
export const BUNDLE_FORMAT = 1;

/** Ids of the two corpora. Their metrics are reported separately and never merged. */
export const SYNTHETIC = "synthetic";
export const SNAPSHOT = "stackprep-snapshot";

/** Corpus directories relative to the project directory, keyed by pin id. */
export const CORPUS_DIRS: Record<string, string> = {
  [SYNTHETIC]: "corpora/synthetic",
  [SNAPSHOT]: "corpora/stackprep",
};

export const CORPUS_PINS: PinSpec[] = Object.entries(CORPUS_DIRS).map(([id, dir]) => ({ id, kind: "corpus", files: [dir] }));

export interface CorpusManifest {
  format: number;
  id: string;
  label: string;
  commit_sha: string;
  /** A directory of files, or a bundle JSON file holding them; relative to the corpus directory. */
  source: { type: "directory" | "bundle"; path: string };
  /** Bundle sources: git pathspecs, a path regex to keep and regexes to drop (see scripts/snapshot.ts). */
  include?: string[];
  match?: string;
  exclude?: string[];
  notes?: string[];
  [key: string]: unknown;
}

export interface CorpusBundle {
  format: number;
  commit_sha: string;
  files: Record<string, string>;
}

export interface CorpusSource {
  manifest: CorpusManifest;
  /** Repository path to text with LF line endings, sorted by path. */
  files: Map<string, string>;
}

function safePath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.includes("\\") && !/^[A-Za-z]:/.test(path) &&
    !path.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

function byPath<T>(entries: Iterable<[string, T]>): Map<string, T> {
  return new Map([...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** A Windows checkout with core.autocrlf rewrites line endings; facts must not depend on it. */
const lf = (text: string) => text.replace(/\r\n/g, "\n");

async function readTree(dir: URL, prefix = ""): Promise<[string, string][]> {
  const out: [string, string][] = [];
  for await (const entry of Deno.readDir(dir)) {
    const path = `${prefix}${entry.name}`;
    if (entry.isDirectory) {
      out.push(...await readTree(new URL(`${entry.name}/`, dir), `${path}/`));
    } else if (entry.isFile) {
      out.push([path, lf(await Deno.readTextFile(new URL(entry.name, dir)))]);
    }
  }
  return out;
}

/** Reads `corpus.json` and the files it points at. `dir` must end with a slash. */
export async function loadCorpus(dir: URL): Promise<CorpusSource> {
  const manifest = JSON.parse(await Deno.readTextFile(new URL("corpus.json", dir))) as CorpusManifest;
  if (manifest.format !== MANIFEST_FORMAT) {
    throw new Error(`corpus: ${dir.pathname}corpus.json is not format ${MANIFEST_FORMAT}`);
  }
  if (!/^[0-9a-f]{40}$/.test(manifest.commit_sha)) {
    throw new Error(`corpus ${manifest.id}: commit_sha must be 40 lowercase hex characters`);
  }
  if (!safePath(manifest.source.path)) {
    throw new Error(`corpus ${manifest.id}: unsafe source path "${manifest.source.path}"`);
  }

  let entries: [string, string][];
  if (manifest.source.type === "directory") {
    entries = await readTree(new URL(`${manifest.source.path}/`, dir));
  } else {
    const bundle = JSON.parse(await Deno.readTextFile(new URL(manifest.source.path, dir))) as CorpusBundle;
    if (bundle.format !== BUNDLE_FORMAT || bundle.commit_sha !== manifest.commit_sha) {
      throw new Error(`corpus ${manifest.id}: bundle is not format ${BUNDLE_FORMAT} at commit ${manifest.commit_sha}; rebuild it`);
    }
    entries = Object.entries(bundle.files).map(([path, text]) => [path, lf(text)]);
  }
  const unsafe = entries.filter(([path]) => !safePath(path)).map(([path]) => path);
  if (unsafe.length > 0) {
    throw new Error(`corpus ${manifest.id}: unsafe file paths: ${unsafe.join(", ")}`);
  }
  if (entries.length === 0) {
    throw new Error(`corpus ${manifest.id}: no files`);
  }
  return { manifest, files: byPath(entries) };
}

/** Loads the corpus pinned under `id`, relative to the project directory. */
export async function loadPinnedCorpus(projectDir: URL, id: string): Promise<CorpusSource> {
  const dir = CORPUS_DIRS[id];
  if (!dir) {
    throw new Error(`corpus: unknown corpus "${id}"`);
  }
  const source = await loadCorpus(new URL(`${dir}/`, projectDir));
  if (source.manifest.id !== id) {
    throw new Error(`corpus: ${dir}/corpus.json declares id "${source.manifest.id}", expected "${id}"`);
  }
  return source;
}
