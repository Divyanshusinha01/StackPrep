import { canonicalJson, type ComponentChange, componentDiff, hashCanonical } from "./keys.ts";
import type { EvalMode, Recorder } from "./types.ts";

/** Bumped whenever the key derivation or the stored file shape changes; part of every key. */
export const RECORDING_FORMAT = 1;

/** Everything that determines a recording key. Stored verbatim next to the output for review and diagnostics. */
export interface KeyComponents {
  format: number;
  site: string;
  sample: number;
  /** Pin id to content hash for the corpora and datasets in force. */
  pins: Record<string, string>;
  /** Project-supplied, output-affecting settings and inputs. */
  components: Record<string, unknown>;
}

export interface StoredRecording extends KeyComponents {
  key: string;
  output: unknown;
}

export interface ReplayMissDiagnostic {
  site: string;
  sample: number;
  key: string;
  /** Closest stored recording for the same site, or undefined when the site has none. */
  nearest?: { key: string; sample: number; changes: ComponentChange[] };
}

export class ReplayMissError extends Error {
  constructor(readonly diagnostic: ReplayMissDiagnostic) {
    super(describeMiss(diagnostic));
    this.name = "ReplayMissError";
  }
}

export interface RecorderStats {
  /** Served from a stored recording. */
  replayed: number;
  /** Produced and written in record mode. */
  recorded: number;
  /** Produced in live mode, not stored. */
  live: number;
  misses: ReplayMissDiagnostic[];
}

export interface FileRecorder extends Recorder {
  readonly mode: EvalMode;
  /** A recorder sharing this one's store and stats that injects only the named pins into keys. */
  forPins(ids: string[]): FileRecorder;
  /** Keys read or written during this run, sorted; lets callers find unused recordings. */
  usedKeys(): string[];
  stats(): RecorderStats;
}

export interface FileRecorderOptions {
  /** Directory holding `<site>/<key>.json` files. */
  dir: string;
  /**
   * replay: read only, a missing recording throws ReplayMissError.
   * record: reuse a stored recording, otherwise produce and write it, so only changed sites are re-recorded.
   * live: always produce, never read or write.
   */
  mode: EvalMode;
  /** Pin hashes of corpora and datasets. Never include the recordings pin itself, or every write would invalidate every key. */
  pins: Record<string, string>;
}

const SITE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * File-backed recorder keyed on canonical JSON of (format, site, sample, pins, components). Outputs must be
 * JSON-compatible; record mode returns the stored round-trip, so record and replay hand callers equal values.
 */
export function createFileRecorder(options: FileRecorderOptions): FileRecorder {
  const store = new RecordingStore(options.dir.replace(/[\\/]+$/, ""));
  const stats: RecorderStats = { replayed: 0, recorded: 0, live: 0, misses: [] };
  const used = new Set<string>();
  const inFlight = new Map<string, Promise<unknown>>();

  const build = (pins: Record<string, string>): FileRecorder => ({
    mode: options.mode,
    forPins(ids) {
      const scoped: Record<string, string> = {};
      for (const id of ids) {
        if (!(id in pins)) throw new Error(`recorder: unknown pin "${id}"`);
        scoped[id] = pins[id];
      }
      return build(scoped);
    },
    usedKeys: () => [...used].sort(),
    stats: () => ({ ...stats, misses: [...stats.misses] }),
    async call<T>(
      req: { site: string; sample?: number; components: Record<string, unknown> },
      produce: () => Promise<T>,
    ): Promise<T> {
      const parts = keyComponents(req, pins);
      if (options.mode === "live") {
        stats.live++;
        return await produce();
      }
      const key = await recordingKey(parts);
      used.add(key);

      const pending = inFlight.get(key);
      if (pending) return await pending as T;
      const stored = await store.read(parts.site, key);
      if (stored) {
        stats.replayed++;
        return stored.output as T;
      }
      if (options.mode === "replay") {
        const diagnostic: ReplayMissDiagnostic = {
          site: parts.site,
          sample: parts.sample,
          key,
          nearest: await store.nearest(parts),
        };
        stats.misses.push(diagnostic);
        throw new ReplayMissError(diagnostic);
      }

      const racing = inFlight.get(key);
      if (racing) return await racing as T;
      const work = (async () => {
        const output = await produce();
        const recording: StoredRecording = { ...parts, key, output: roundTrip(output, parts.site) };
        await store.write(recording);
        stats.recorded++;
        return recording.output;
      })();
      inFlight.set(key, work);
      try {
        return await work as T;
      } finally {
        inFlight.delete(key);
      }
    },
  });

  return build({ ...options.pins });
}

export function keyComponents(
  req: { site: string; sample?: number; components: Record<string, unknown> },
  pins: Record<string, string>,
): KeyComponents {
  if (!SITE_PATTERN.test(req.site)) throw new Error(`recorder: invalid site name "${req.site}"`);
  const sample = req.sample ?? 0;
  if (!Number.isInteger(sample) || sample < 0) throw new Error(`recorder: sample must be a non-negative integer, got ${sample}`);
  return { format: RECORDING_FORMAT, site: req.site, sample, pins: { ...pins }, components: req.components };
}

export function recordingKey(parts: KeyComponents): Promise<string> {
  return hashCanonical(parts);
}

/** Human-readable replay-miss message naming the differing key components. */
export function describeMiss(d: ReplayMissDiagnostic): string {
  const head = `replay miss at site "${d.site}" sample ${d.sample} (key ${d.key.slice(0, 12)})`;
  if (!d.nearest) return `${head}: no recordings exist for this site. Run "eval record" to capture it.`;
  const changes = d.nearest.changes.map((c) => `${c.path} (${c.kind})`).join(", ");
  return `${head}: nearest recording ${d.nearest.key.slice(0, 12)} (sample ${d.nearest.sample}) differs in ${
    changes || "nothing visible; the stored file may be stale or hand-edited"
  }. Re-record this site if the change is intended.`;
}

function roundTrip(output: unknown, site: string): unknown {
  if (output === undefined) throw new TypeError(`recorder: site "${site}" produced undefined, which cannot be recorded`);
  return JSON.parse(canonicalJson(output));
}

function comparable(parts: KeyComponents): Record<string, unknown> {
  return { format: parts.format, sample: parts.sample, pins: parts.pins, components: parts.components };
}

class RecordingStore {
  #sites = new Map<string, Promise<StoredRecording[]>>();

  constructor(private readonly dir: string) {}

  async read(site: string, key: string): Promise<StoredRecording | undefined> {
    let text: string;
    try {
      text = await Deno.readTextFile(this.#path(site, key));
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return undefined;
      throw error;
    }
    const recording = await this.#parse(text, `${site}/${key}.json`);
    if (recording.key !== key) throw new Error(`recorder: ${site}/${key}.json holds key ${recording.key}`);
    return recording;
  }

  async write(recording: StoredRecording): Promise<void> {
    await Deno.mkdir(`${this.dir}/${recording.site}`, { recursive: true });
    const pretty = JSON.stringify(JSON.parse(canonicalJson(recording)), null, 2);
    await Deno.writeTextFile(this.#path(recording.site, recording.key), `${pretty}\n`);
    this.#sites.delete(recording.site);
  }

  /** Stored recording for the site with the fewest differing key components; ties prefer the same sample, then key order. */
  async nearest(parts: KeyComponents): Promise<ReplayMissDiagnostic["nearest"]> {
    const target = comparable(parts);
    let best: NonNullable<ReplayMissDiagnostic["nearest"]> | undefined;
    for (const recording of await this.#list(parts.site)) {
      const changes = componentDiff(comparable(recording), target);
      const candidate = { key: recording.key, sample: recording.sample, changes };
      if (!best || rank(candidate, parts.sample) < rank(best, parts.sample)) best = candidate;
    }
    return best;
  }

  #list(site: string): Promise<StoredRecording[]> {
    let pending = this.#sites.get(site);
    if (!pending) {
      pending = this.#load(site);
      this.#sites.set(site, pending);
    }
    return pending;
  }

  async #load(site: string): Promise<StoredRecording[]> {
    const out: StoredRecording[] = [];
    try {
      for await (const entry of Deno.readDir(`${this.dir}/${site}`)) {
        if (!entry.isFile || !entry.name.endsWith(".json")) continue;
        out.push(await this.#parse(await Deno.readTextFile(`${this.dir}/${site}/${entry.name}`), `${site}/${entry.name}`));
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return [];
      throw error;
    }
    return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  async #parse(text: string, label: string): Promise<StoredRecording> {
    const recording = JSON.parse(text) as StoredRecording;
    const expected = await recordingKey({
      format: recording.format,
      site: recording.site,
      sample: recording.sample,
      pins: recording.pins,
      components: recording.components,
    });
    if (expected !== recording.key) {
      throw new Error(`recorder: ${label} is corrupt; its stored key components hash to ${expected.slice(0, 12)}`);
    }
    return recording;
  }

  #path(site: string, key: string): string {
    return `${this.dir}/${site}/${key}.json`;
  }
}

function rank(c: { key: string; sample: number; changes: ComponentChange[] }, sample: number): string {
  return `${String(c.changes.length).padStart(6, "0")}:${c.sample === sample ? 0 : 1}:${c.key}`;
}
