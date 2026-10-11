export type EvalMode = "replay" | "record" | "live";

/** How a number was produced. Enforces the honest distinctions in reports and baselines. */
export type Provenance =
  | "deterministic" // no model involved (retrieval, citation validity)
  | "recorded_live" // computed from live model samples captured at record time
  | "replay_reproducibility" // pipeline check over saved samples; says nothing about the model
  | "judged"; // involves a recorded judge; report judge calibration beside it

export interface Metric {
  /** Stable, e.g. "retrieval.recall_at_5.hybrid". */
  id: string;
  /** Human name, e.g. "Recall@5 (hybrid)". */
  label: string;
  value: number;
  /** Sample size behind the value. */
  n: number;
  /** Seeded bootstrap interval when meaningful. */
  ci?: [number, number];
  direction: "higher_is_better" | "lower_is_better";
  provenance: Provenance;
  /** Pin id of the corpus, e.g. "synthetic" or "stackprep-snapshot". Metrics from different corpora are never merged. */
  corpus: string;
  /** False = informational, never blocks CI. */
  gate: boolean;
  /** Absolute slack beyond the baseline interval before a worse value counts as a regression. Default 0. */
  tolerance?: number;
  note?: string;
}

export interface SuiteResult {
  metrics: Metric[];
  /** Per-case detail for the report; never gates. */
  cases?: Array<{ id: string; ok: boolean; detail?: string }>;
  /** Anything the reader must know to interpret the numbers (limits, unlabelled coverage). */
  caveats?: string[];
}

/** The only generic hook for model calls. Providers are wrapped by the project, not by core. */
export interface Recorder {
  call<T>(
    req: { site: string; sample?: number; components: Record<string, unknown> },
    produce: () => Promise<T>,
  ): Promise<T>;
}

export interface RunEnv {
  mode: EvalMode;
  recorder: Recorder;
  /** Drives bootstrap and any sampling; fixed by default. */
  seed: number;
  /** K for live capture. */
  samples: number;
  log: (line: string) => void;
}

export interface Suite<Ctx> {
  /** "retrieval", "support", ... */
  id: string;
  /** Pin ids this suite depends on, so a stale dataset or corpus fails integrity checks. */
  pins: string[];
  run(ctx: Ctx, env: RunEnv): Promise<SuiteResult>;
}

export interface PinSpec {
  /** "synthetic", "dataset.retrieval", ... */
  id: string;
  kind: "corpus" | "dataset" | "recordings";
  /** Paths relative to the project directory. */
  files: string[];
}

export interface Project<Ctx> {
  /** "stackprep" */
  id: string;
  /** Files and versions to hash and verify. See pins.json. */
  pins: PinSpec[];
  /** Output-affecting configuration (models, reasoning effort, K, embedding settings), stored with results and baselines. */
  config: Record<string, unknown>;
  /** Default K for live capture. Default 1. */
  samples?: number;
  /** Pin ids injected into recording keys for calls made during setup. Default: every corpus pin. */
  setupPins?: string[];
  /** Loads corpora and builds the project's own adapters. Core never looks inside Ctx. */
  setup(env: RunEnv): Promise<Ctx>;
  suites: Suite<Ctx>[];
}

export interface SuiteRun {
  id: string;
  pins: string[];
  status: "ok" | "error";
  error?: string;
  metrics: Metric[];
  cases: Array<{ id: string; ok: boolean; detail?: string }>;
  caveats: string[];
}

/** Contents of results/<project>/latest.json. Holds no timestamps or machine paths, so equal inputs give equal bytes. */
export interface RunResults {
  format: number;
  project: string;
  mode: EvalMode;
  seed: number;
  samples: number;
  config: Record<string, unknown>;
  /** True when only some suites ran; missing metrics from other suites are then not reported. */
  partial: boolean;
  /** Content hashes computed from disk for every pin, with the version recorded in pins.json (null when unpinned). */
  pins: Record<string, { kind: PinSpec["kind"]; version: number | null; hash: string }>;
  integrity: { ok: boolean; problems: string[]; warnings: string[] };
  recordings: {
    /** Hash of the sorted recording keys used, identifying the exact recording set behind the numbers. */
    setHash: string;
    used: number;
    replayed: number;
    recorded: number;
    live: number;
    misses: string[];
  };
  /** Set when the run stopped before suites ran (integrity failure or setup error). */
  error?: string;
  suites: SuiteRun[];
}
