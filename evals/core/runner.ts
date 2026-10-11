import { hashCanonical } from "./keys.ts";
import { computePins, describeCheck, readPinsFile, recorderPins, verifyPins } from "./pins.ts";
import { createFileRecorder, describeMiss, type FileRecorder } from "./recording.ts";
import { RESULTS_FORMAT } from "./report.ts";
import type { EvalMode, Metric, PinSpec, Project, RunEnv, RunResults, SuiteRun } from "./types.ts";

export interface RunOptions {
  /** Directory holding the project's pins.json and recordings/. */
  projectDir: URL;
  mode: EvalMode;
  seed: number;
  samples: number;
  /** Run only these suite ids. */
  suites?: readonly string[];
  log: (line: string) => void;
}

const METRIC_ID = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/;
const PROVENANCES = new Set<Metric["provenance"]>(["deterministic", "recorded_live", "replay_reproducibility", "judged"]);
const DIRECTIONS = new Set<Metric["direction"]>(["higher_is_better", "lower_is_better"]);

/** The project definition or the requested suites are invalid; nothing ran. */
export class RunConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunConfigError";
  }
}

/** File URL to a native path for APIs that take strings. */
export function urlToPath(url: URL): string {
  const path = decodeURIComponent(url.pathname);
  return Deno.build.os === "windows" ? path.replace(/^\/([A-Za-z]:)/, "$1") : path;
}

/**
 * Verifies pins, runs the project's suites with a file-backed recorder, and validates what they return.
 * Never writes results or baselines; the caller decides what to persist.
 */
export async function runProject<Ctx>(project: Project<Ctx>, options: RunOptions): Promise<RunResults> {
  const pinKinds = new Map<string, PinSpec["kind"]>(project.pins.map((p) => [p.id, p.kind]));
  const selected = selectSuites(project, options.suites);
  for (const suite of selected) {
    const unknown = suite.pins.filter((id) => !pinKinds.has(id));
    if (unknown.length > 0) throw new RunConfigError(`suite "${suite.id}" depends on undeclared pin(s): ${unknown.join(", ")}`);
  }

  const computed = await computePins(options.projectDir, project.pins);
  const pinsFile = await readPinsFile(new URL("pins.json", options.projectDir));
  // Record and live runs are expected to change recordings; replay must match them exactly.
  const verification = verifyPins(computed, pinsFile, { tolerate: options.mode === "replay" ? [] : ["recordings"] });
  const pins: RunResults["pins"] = {};
  for (const pin of computed) pins[pin.id] = { kind: pin.kind, version: pinsFile.pins[pin.id]?.version ?? null, hash: pin.hash };

  const base = {
    format: RESULTS_FORMAT,
    project: project.id,
    mode: options.mode,
    seed: options.seed,
    samples: options.samples,
    config: project.config,
    partial: selected.length !== project.suites.length,
    pins,
    integrity: {
      ok: verification.ok,
      problems: verification.checks.filter((c) => c.blocking).map(describeCheck),
      warnings: verification.checks.filter((c) => !c.blocking && c.status !== "ok").map(describeCheck),
    },
  };

  const recorder = createFileRecorder({
    dir: urlToPath(new URL("recordings/", options.projectDir)),
    mode: options.mode,
    pins: recorderPins(computed),
  });
  const finish = async (suites: SuiteRun[], error?: string): Promise<RunResults> => {
    const stats = recorder.stats();
    return {
      ...base,
      recordings: {
        setHash: await hashCanonical(recorder.usedKeys()),
        used: recorder.usedKeys().length,
        replayed: stats.replayed,
        recorded: stats.recorded,
        live: stats.live,
        misses: stats.misses.map(describeMiss).sort(),
      },
      error,
      suites,
    };
  };

  if (!verification.ok) {
    return finish([], "pin integrity failed; suites did not run");
  }

  const envFor = (scoped: FileRecorder): RunEnv => ({
    mode: options.mode,
    recorder: scoped,
    seed: options.seed,
    samples: options.samples,
    log: options.log,
  });
  const setupPins = project.setupPins ?? project.pins.filter((p) => p.kind === "corpus").map((p) => p.id);
  let ctx: Ctx;
  try {
    options.log(`setup ${project.id}`);
    ctx = await project.setup(envFor(recorder.forPins(withoutRecordings(setupPins, pinKinds))));
  } catch (error) {
    return finish([], `setup failed: ${message(error)}`);
  }

  const suites: SuiteRun[] = [];
  const seenIds = new Set<string>();
  for (const suite of selected) {
    options.log(`suite ${suite.id}`);
    const run: SuiteRun = { id: suite.id, pins: [...suite.pins].sort(), status: "ok", metrics: [], cases: [], caveats: [] };
    try {
      const result = await suite.run(ctx, envFor(recorder.forPins(withoutRecordings(suite.pins, pinKinds))));
      const problems = result.metrics.flatMap((m) => validateMetric(m, pinKinds, seenIds));
      if (problems.length > 0) throw new Error(`invalid metrics: ${problems.join("; ")}`);
      run.metrics = result.metrics;
      run.cases = result.cases ?? [];
      run.caveats = result.caveats ?? [];
    } catch (error) {
      run.status = "error";
      run.error = message(error);
      run.metrics = [];
    }
    suites.push(run);
  }
  return finish(suites);
}

function selectSuites<Ctx>(project: Project<Ctx>, ids: readonly string[] | undefined): Project<Ctx>["suites"] {
  const declared = new Set<string>();
  for (const suite of project.suites) {
    if (declared.has(suite.id)) throw new RunConfigError(`duplicate suite id "${suite.id}"`);
    declared.add(suite.id);
  }
  if (!ids) return project.suites;
  const unknown = ids.filter((id) => !declared.has(id));
  if (unknown.length > 0) throw new RunConfigError(`unknown suite(s): ${unknown.join(", ")}; known: ${[...declared].join(", ")}`);
  return project.suites.filter((s) => ids.includes(s.id));
}

function withoutRecordings(ids: readonly string[], kinds: Map<string, PinSpec["kind"]>): string[] {
  return ids.filter((id) => kinds.get(id) !== "recordings");
}

function validateMetric(m: Metric, kinds: Map<string, PinSpec["kind"]>, seen: Set<string>): string[] {
  const out: string[] = [];
  const at = typeof m.id === "string" ? m.id : "<no id>";
  if (typeof m.id !== "string" || !METRIC_ID.test(m.id)) out.push(`${at}: invalid id`);
  else if (seen.has(m.id)) out.push(`${at}: duplicate id`);
  else seen.add(m.id);
  if (typeof m.label !== "string" || !m.label) out.push(`${at}: missing label`);
  if (!Number.isFinite(m.value)) out.push(`${at}: value must be finite`);
  if (!Number.isInteger(m.n) || m.n < 0) out.push(`${at}: n must be a non-negative integer`);
  if (m.ci !== undefined && !(Array.isArray(m.ci) && m.ci.length === 2 && m.ci.every(Number.isFinite) && m.ci[0] <= m.ci[1])) {
    out.push(`${at}: ci must be [low, high] with finite low <= high`);
  }
  if (!DIRECTIONS.has(m.direction)) out.push(`${at}: invalid direction`);
  if (!PROVENANCES.has(m.provenance)) out.push(`${at}: invalid provenance`);
  if (kinds.get(m.corpus) !== "corpus") out.push(`${at}: corpus "${m.corpus}" is not a declared corpus pin`);
  if (typeof m.gate !== "boolean") out.push(`${at}: gate must be boolean`);
  if (m.tolerance !== undefined && !(Number.isFinite(m.tolerance) && m.tolerance >= 0)) out.push(`${at}: tolerance must be >= 0`);
  return out;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
