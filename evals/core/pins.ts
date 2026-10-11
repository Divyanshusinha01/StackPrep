import { hashCanonical, sha256, stableJson } from "./keys.ts";
import type { PinSpec } from "./types.ts";

export const PINS_FORMAT = 1;

export interface ChangelogEntry {
  version: number;
  date: string;
  user: string;
  reason: string;
  hash: string;
}

export interface PinEntry {
  kind: PinSpec["kind"];
  version: number;
  hash: string;
  /** Relative path to content hash, so a mismatch names the files that changed. */
  files: Record<string, string>;
  changelog: ChangelogEntry[];
}

/** Contents of a project's pins.json. */
export interface PinsFile {
  format: number;
  pins: Record<string, PinEntry>;
}

/** A pin's identity as computed from the files on disk now. */
export interface ComputedPin {
  id: string;
  kind: PinSpec["kind"];
  hash: string;
  files: Record<string, string>;
  /** Spec paths that do not exist. */
  missing: string[];
}

export interface FileChange {
  path: string;
  change: "added" | "removed" | "changed";
}

export interface PinCheck {
  id: string;
  status: "ok" | "unpinned" | "stale" | "kind_changed" | "missing_files" | "empty" | "orphaned";
  /** Blocking checks fail integrity; the rest are warnings. */
  blocking: boolean;
  detail: string;
  files?: FileChange[];
}

export interface PinVerification {
  ok: boolean;
  checks: PinCheck[];
}

/**
 * Hashes the files under each path (a file or a directory, walked recursively) relative to `baseDir`.
 * Paths must stay inside `baseDir` so hashes are portable between machines.
 */
export async function hashFiles(
  baseDir: URL,
  paths: readonly string[],
): Promise<{ files: Record<string, string>; missing: string[] }> {
  const files: Record<string, string> = {};
  const missing: string[] = [];
  for (const raw of paths) {
    const path = normalizeRelative(raw);
    const url = new URL(path, baseDir);
    let info: Deno.FileInfo;
    try {
      info = await Deno.stat(url);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        missing.push(path);
        continue;
      }
      throw error;
    }
    if (info.isDirectory) await hashDir(new URL(`${path.replace(/\/$/, "")}/`, baseDir), path.replace(/\/$/, ""), files);
    else files[path] = await hashContent(await Deno.readFile(url));
  }
  return { files: sortRecord(files), missing: missing.sort() };
}

async function hashDir(dir: URL, prefix: string, out: Record<string, string>): Promise<void> {
  const entries: Deno.DirEntry[] = [];
  for await (const entry of Deno.readDir(dir)) entries.push(entry);
  for (const entry of entries) {
    const path = `${prefix}/${entry.name}`;
    if (entry.isDirectory) await hashDir(new URL(`${entry.name}/`, dir), path, out);
    else if (entry.isFile) out[path] = await hashContent(await Deno.readFile(new URL(entry.name, dir)));
  }
}

/**
 * SHA-256 of file bytes. Text (no NUL byte) is hashed with CRLF folded to LF, because a Windows checkout with
 * core.autocrlf rewrites line endings and must hash the same as CI.
 */
export function hashContent(bytes: Uint8Array): Promise<string> {
  if (bytes.includes(0)) return sha256(bytes);
  const out = new Uint8Array(bytes.length);
  let n = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0d && bytes[i + 1] === 0x0a) continue;
    out[n++] = bytes[i];
  }
  return sha256(out.subarray(0, n));
}

function normalizeRelative(raw: string): string {
  const path = raw.replace(/\\/g, "/").replace(/^\.\//, "");
  if (path === "" || path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.split("/").includes("..")) {
    throw new Error(`pins: path "${raw}" must be relative and stay inside the project directory`);
  }
  return path;
}

function sortRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Computes every pin from disk. The pin hash covers paths and contents, so renames change it too. */
export async function computePins(baseDir: URL, specs: readonly PinSpec[]): Promise<ComputedPin[]> {
  const seen = new Set<string>();
  const out: ComputedPin[] = [];
  for (const spec of specs) {
    if (seen.has(spec.id)) throw new Error(`pins: duplicate pin id "${spec.id}"`);
    seen.add(spec.id);
    const { files, missing } = await hashFiles(baseDir, spec.files);
    // Recordings start out absent and may legitimately be empty; the hash still catches deletions.
    const absentOk = spec.kind === "recordings";
    out.push({ id: spec.id, kind: spec.kind, hash: await hashCanonical(files), files, missing: absentOk ? [] : missing });
  }
  return out;
}

/**
 * Compares computed pins with pins.json. Any unpinned, changed or missing pin fails integrity, except kinds
 * listed in `tolerate` (record mode tolerates the recordings it is about to change), which become warnings.
 */
export function verifyPins(
  computed: readonly ComputedPin[],
  file: PinsFile,
  options: { tolerate?: ReadonlyArray<PinSpec["kind"]> } = {},
): PinVerification {
  const tolerate = new Set(options.tolerate ?? []);
  const checks: PinCheck[] = [];
  for (const pin of computed) {
    const entry = file.pins[pin.id];
    const blocking = !tolerate.has(pin.kind);
    if (pin.missing.length > 0) {
      checks.push({ id: pin.id, status: "missing_files", blocking: true, detail: `missing: ${pin.missing.join(", ")}` });
    } else if (Object.keys(pin.files).length === 0 && pin.kind !== "recordings") {
      checks.push({ id: pin.id, status: "empty", blocking: true, detail: "no files matched" });
    } else if (!entry) {
      checks.push({ id: pin.id, status: "unpinned", blocking, detail: `not in pins.json; run "eval pin --pins ${pin.id}"` });
    } else if (entry.kind !== pin.kind) {
      checks.push({ id: pin.id, status: "kind_changed", blocking: true, detail: `pins.json says ${entry.kind}, project says ${pin.kind}` });
    } else if (entry.hash !== pin.hash) {
      const files = fileChanges(entry.files, pin.files);
      checks.push({
        id: pin.id,
        status: "stale",
        blocking,
        detail: `content changed since v${entry.version} (${files.length} file(s)); run "eval pin --pins ${pin.id}" with a reason`,
        files,
      });
    } else {
      checks.push({ id: pin.id, status: "ok", blocking: false, detail: `v${entry.version}` });
    }
  }
  const known = new Set(computed.map((p) => p.id));
  for (const id of Object.keys(file.pins).sort()) {
    if (!known.has(id)) {
      checks.push({ id, status: "orphaned", blocking: false, detail: "in pins.json but not declared by the project" });
    }
  }
  return { ok: checks.every((c) => !c.blocking), checks };
}

export function fileChanges(before: Record<string, string>, after: Record<string, string>): FileChange[] {
  const out: FileChange[] = [];
  for (const path of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!(path in before)) out.push({ path, change: "added" });
    else if (!(path in after)) out.push({ path, change: "removed" });
    else if (before[path] !== after[path]) out.push({ path, change: "changed" });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function describeCheck(check: PinCheck): string {
  const files = check.files?.length ? ` [${check.files.map((f) => `${f.path} (${f.change})`).join(", ")}]` : "";
  return `${check.id}: ${check.status}, ${check.detail}${files}`;
}

/** Pin id to hash for the recorder. Recordings pins are left out, or every recorded write would invalidate every key. */
export function recorderPins(computed: readonly ComputedPin[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pin of computed) if (pin.kind !== "recordings") out[pin.id] = pin.hash;
  return out;
}

export async function readPinsFile(url: URL): Promise<PinsFile> {
  let text: string;
  try {
    text = await Deno.readTextFile(url);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return { format: PINS_FORMAT, pins: {} };
    throw error;
  }
  const parsed = JSON.parse(text) as PinsFile;
  if (parsed?.format !== PINS_FORMAT || typeof parsed.pins !== "object" || parsed.pins === null) {
    throw new Error(`pins: ${url.pathname} is not a format ${PINS_FORMAT} pins file`);
  }
  return parsed;
}

export function writePinsFile(url: URL, file: PinsFile): Promise<void> {
  return Deno.writeTextFile(url, stableJson(file));
}

export interface PinUpdate {
  id: string;
  from: { version: number; hash: string } | null;
  to: { version: number; hash: string };
  files: FileChange[];
}

/**
 * Records the current content of the selected pins, bumping each changed pin's version and appending a
 * changelog entry. Unchanged pins are left alone. Pure: the caller writes the file.
 */
export function updatePins(
  file: PinsFile,
  computed: readonly ComputedPin[],
  ids: readonly string[] | "all",
  meta: { date: string; user: string; reason: string },
): { file: PinsFile; updates: PinUpdate[] } {
  if (!meta.reason.trim()) throw new Error("pins: a reason is required");
  const byId = new Map(computed.map((p) => [p.id, p]));
  const selected = ids === "all" ? [...byId.keys()] : [...ids];
  for (const id of selected) if (!byId.has(id)) throw new Error(`pins: unknown pin "${id}"`);

  const pins: Record<string, PinEntry> = { ...file.pins };
  const updates: PinUpdate[] = [];
  for (const id of [...new Set(selected)].sort()) {
    const pin = byId.get(id)!;
    if (pin.missing.length > 0) throw new Error(`pins: ${id} has missing files: ${pin.missing.join(", ")}`);
    if (Object.keys(pin.files).length === 0 && pin.kind !== "recordings") throw new Error(`pins: ${id} matched no files`);
    const prev = pins[id];
    if (prev && prev.hash === pin.hash && prev.kind === pin.kind) continue;
    const version = prev ? prev.version + 1 : 1;
    pins[id] = {
      kind: pin.kind,
      version,
      hash: pin.hash,
      files: pin.files,
      changelog: [...(prev?.changelog ?? []), { version, date: meta.date, user: meta.user, reason: meta.reason.trim(), hash: pin.hash }],
    };
    updates.push({
      id,
      from: prev ? { version: prev.version, hash: prev.hash } : null,
      to: { version, hash: pin.hash },
      files: fileChanges(prev?.files ?? {}, pin.files),
    });
  }
  return { file: { format: PINS_FORMAT, pins: sortRecord(pins) }, updates };
}
