/**
 * Evaluation consistency on one corpus, reported as two separate things:
 * - model consistency (recorded_live): each transcript goes K times through the real `evaluateAnswer`,
 *   as K separate requests (sample index 0..K-1, each its own recording), and score spread and
 *   rating, guidance and discrepancy agreement are computed from those K raw outputs. They describe the
 *   model as of the recording, which is named and dated beside the numbers.
 * - replay reproducibility (replay_reproducibility): the metric values computed at record time are
 *   stored as their own recording; replay recomputes them from the stored samples, twice, and fails
 *   unless both passes agree byte for byte and equal the stored values. It says nothing about the model.
 *
 * A transcript is one turn of a scripted session, evaluated from a fresh store so all K samples send the
 * same request. A strong-above-weak sanity check blocks constant or label-blind output, which would
 * otherwise look perfectly consistent.
 */
import { canonicalJson, hashCanonical } from "../../../core/keys.ts";
import { ReplayMissError } from "../../../core/recording.ts";
import { agreement, bootstrapCI, mean, range, std } from "../../../core/stats.ts";
import type { Metric, PinSpec, RunEnv, Suite, SuiteResult } from "../../../core/types.ts";
import { recordedAIProvider } from "../src/ai.ts";
import { pipelineMemory } from "../src/analysis.ts";
import type { IndexedCorpus } from "../src/corpus.ts";
import { evaluateTurn, evaluationToolContext, interviewStore } from "../src/evaluate.ts";
import {
  evidenceThrough,
  loadSessions,
  type PipelineContext,
  scopedRecorder,
  type SessionsDataset,
  sessionMessages,
  sessionsPinId,
} from "../src/sessions.ts";

export const CONSISTENCY_DATASET_FORMAT = 1;
/** Bump when an intended change to the metric computation should re-record the stored summaries. */
export const CONSISTENCY_SUMMARY_FORMAT = 1;
export const SAMPLE_SITE = "consistency_evaluation";
export const SUMMARY_SITE = "consistency_summary";
/** Strong transcripts must out-score weak ones by at least this much (mean score, 1-5 scale). */
export const MIN_SEPARATION = 1;
/** Evaluation calls in flight at once when recording. */
const SAMPLE_CONCURRENCY = 6;

export const EXPECTED = ["strong", "weak", "mixed"] as const;
export type Expected = typeof EXPECTED[number];

export interface ConsistencyTranscript {
  session: string;
  /** 1-based turn within the session. */
  turn: number;
  expected: Expected;
  why: string;
}

export interface ConsistencyDataset {
  format: number;
  corpus: string;
  guidelines: string[];
  transcripts: ConsistencyTranscript[];
}

export const consistencyPath = (corpusId: string) => `datasets/consistency/${corpusId}.json`;
export const consistencyPinId = (corpusId: string) => `dataset.consistency.${corpusId}`;
export const transcriptId = (t: Pick<ConsistencyTranscript, "session" | "turn">) => `${t.session}/q${t.turn}`;

export function consistencyDatasetPins(corpusIds: readonly string[]): PinSpec[] {
  return corpusIds.map((id) => ({ id: consistencyPinId(id), kind: "dataset", files: [consistencyPath(id)] }));
}

/** Problems that make a consistency dataset unusable against these sessions; empty when it is valid. */
export function validateConsistency(dataset: ConsistencyDataset, sessions: SessionsDataset): string[] {
  const problems: string[] = [];
  if (dataset.format !== CONSISTENCY_DATASET_FORMAT) problems.push(`format must be ${CONSISTENCY_DATASET_FORMAT}`);
  if (dataset.corpus !== sessions.corpus) problems.push(`dataset is for corpus "${dataset.corpus}", not "${sessions.corpus}"`);
  if (!Array.isArray(dataset.transcripts) || dataset.transcripts.length === 0) return [...problems, "no transcripts"];
  const ids = new Set<string>();
  for (const t of dataset.transcripts) {
    const id = transcriptId(t);
    if (ids.has(id)) problems.push(`${id}: duplicate transcript`);
    ids.add(id);
    const session = sessions.sessions.find((s) => s.id === t.session);
    if (!session) problems.push(`${id}: session "${t.session}" is not in the sessions dataset`);
    else if (!Number.isInteger(t.turn) || t.turn < 1 || t.turn > session.turns.length) problems.push(`${id}: turn must be 1 to ${session.turns.length}`);
    if (!EXPECTED.includes(t.expected)) problems.push(`${id}: expected must be one of ${EXPECTED.join(", ")}`);
    if (typeof t.why !== "string" || !t.why.trim()) problems.push(`${id}: missing why`);
  }
  return problems;
}

export async function loadConsistency(projectDir: URL, sessions: SessionsDataset): Promise<ConsistencyDataset> {
  const path = consistencyPath(sessions.corpus);
  const dataset = JSON.parse(await Deno.readTextFile(new URL(path, projectDir))) as ConsistencyDataset;
  const problems = validateConsistency(dataset, sessions);
  if (problems.length > 0) throw new Error(`${path}: ${problems.join("; ")}`);
  return dataset;
}

/** The fields of one evaluation that the metrics read; null when the tool reported a failure. */
export type Sample = { score: number; rating: string; guidance: string; discrepancy: boolean } | null;

export interface TranscriptSamples {
  id: string;
  expected: Expected;
  /** In sample-index order; shorter than K when replay stopped at an unrecorded sample. */
  samples: Sample[];
  recorded: boolean;
}

export interface TranscriptStats {
  id: string;
  expected: Expected;
  valid: number;
  scoreMean: number;
  scoreStd: number;
  scoreRange: number;
  rating: { mode: string; share: number };
  guidance: { mode: string; share: number };
  discrepancy: { mode: boolean; share: number };
}

/** Everything compared between record time and replay. No confidence intervals: they depend on the run seed. */
export interface ConsistencyValues {
  k: number;
  transcripts: TranscriptStats[];
  /** Transcripts with at least two valid samples. */
  measured: number;
  validRate: number;
  scoreStd: number | null;
  scoreRange: number | null;
  ratingAgreement: number | null;
  guidanceAgreement: number | null;
  discrepancyAgreement: number | null;
  separation: { strong: number; weak: number; value: number } | null;
}

interface StoredSummary {
  recordedAt: string;
  values: ConsistencyValues;
}

export interface ConsistencySuiteOptions {
  /** Whether the headline consistency and reproducibility metrics may gate CI. */
  gate: boolean;
}

export function consistencySuite(corpusId: string, options: ConsistencySuiteOptions): Suite<PipelineContext> {
  return {
    id: `consistency-${corpusId}`,
    pins: [corpusId, sessionsPinId(corpusId), consistencyPinId(corpusId)],
    run: async (ctx, env) => {
      const corpus = ctx.corpora.get(corpusId);
      if (!corpus) throw new Error(`corpus "${corpusId}" is not loaded`);
      const sessions = await loadSessions(ctx.projectDir, corpus);
      const dataset = await loadConsistency(ctx.projectDir, sessions);
      const k = env.samples;
      const collect = await sampleCollector(ctx, corpus, sessions, dataset, env);
      const first = await collect();
      const complete = first.every((t) => t.recorded);
      const values = consistencyValues(first, k);

      let replay: ReplayCheck;
      if (env.mode === "live") {
        replay = { status: "skipped", reason: "live run: samples are not stored, so replay reproducibility is not checked" };
      } else if (!complete) {
        replay = { status: "skipped", reason: "some samples are not recorded, so record-time values cannot be compared" };
      } else {
        // A second independent pass over the stored samples must agree byte for byte.
        const second = await collect();
        if (canonicalJson(second) !== canonicalJson(first)) {
          throw new Error(`replay reproducibility failed: two passes over the stored samples of ${corpusId} differ`);
        }
        replay = await compareWithRecordTime(env, ctx, first, values);
      }
      return consistencyResult({
        corpusId,
        values,
        transcripts: first,
        replay,
        mode: env.mode,
        model: ctx.pipeline.evaluation,
        seed: env.seed,
        gate: options.gate,
      });
    },
  };
}

export type ReplayCheck =
  | { status: "skipped"; reason: string }
  | { status: "missing" }
  | { status: "ok"; recordedAt: string };

/** Returns a function that evaluates every transcript K times, each sample from a fresh store. */
async function sampleCollector(
  ctx: PipelineContext,
  corpus: IndexedCorpus,
  sessions: SessionsDataset,
  dataset: ConsistencyDataset,
  env: RunEnv,
): Promise<() => Promise<TranscriptSamples[]>> {
  const memory = await pipelineMemory(corpus);
  // Keyed on the corpus and sessions only: relabelling transcripts never re-records model samples.
  const recorder = scopedRecorder(env.recorder, [corpus.id, sessionsPinId(corpus.id)]);
  const jobs = dataset.transcripts.flatMap((t) => {
    const session = sessions.sessions.find((s) => s.id === t.session)!;
    const index = t.turn - 1;
    const messages = sessionMessages(session).slice(0, 2 * index + 2);
    const evidence = evidenceThrough(session, index);
    const summary = session.turns[index].answer_summary;
    return Array.from({ length: env.samples }, (_, sample) => ({ t, sample, messages, evidence, summary }));
  });
  return async () => {
    const outcomes = await mapLimited(jobs, async (job): Promise<Sample | "not_recorded"> => {
      const ai = recordedAIProvider(recorder, { provider: ctx.liveAI, site: SAMPLE_SITE, sample: job.sample });
      const store = interviewStore(corpus, memory, sessions.state);
      try {
        const turn = await evaluateTurn(
          { ...evaluationToolContext(corpus, store, ai, ctx.pipeline.evaluation), store },
          job.messages,
          job.evidence,
          job.summary,
        );
        if (!turn) return null;
        const { score, rating, discrepancy } = turn.record;
        return { score, rating, guidance: turn.output.guidance, discrepancy };
      } catch (err) {
        if (err instanceof ReplayMissError) return "not_recorded";
        throw err;
      }
    });
    return dataset.transcripts.map((t) => {
      const own = outcomes.filter((_, i) => jobs[i].t === t);
      const missing = own.indexOf("not_recorded");
      const samples = (missing === -1 ? own : own.slice(0, missing)) as Sample[];
      return { id: transcriptId(t), expected: t.expected, samples, recorded: missing === -1 };
    });
  };
}

/**
 * Compares freshly computed values with those stored at record time. The stored summary is keyed on the
 * exact samples, so different samples are a replay miss naming them, not a silent pass.
 */
async function compareWithRecordTime(env: RunEnv, ctx: PipelineContext, transcripts: TranscriptSamples[], values: ConsistencyValues): Promise<ReplayCheck> {
  let stored: StoredSummary;
  try {
    stored = await env.recorder.call<StoredSummary>(
      {
        site: SUMMARY_SITE,
        components: {
          format: CONSISTENCY_SUMMARY_FORMAT,
          evaluation: ctx.pipeline.evaluation,
          k: values.k,
          samples: await hashCanonical(transcripts.map((t) => ({ id: t.id, expected: t.expected, samples: t.samples }))),
        },
      },
      () => Promise.resolve({ recordedAt: new Date().toISOString(), values }),
    );
  } catch (err) {
    if (err instanceof ReplayMissError) return { status: "missing" };
    throw err;
  }
  if (canonicalJson(stored.values) !== canonicalJson(values)) {
    const changed = Object.keys(values).filter((key) =>
      canonicalJson((stored.values as unknown as Record<string, unknown>)[key]) !== canonicalJson((values as unknown as Record<string, unknown>)[key])
    );
    throw new Error(
      `replay reproducibility failed: values recomputed from the stored samples differ from those stored at record time (${changed.join(", ")}). ` +
        `If the metric computation changed on purpose, bump CONSISTENCY_SUMMARY_FORMAT and run "eval record".`,
    );
  }
  return { status: "ok", recordedAt: stored.recordedAt };
}

/** Per-transcript statistics and aggregates from the raw samples; pure and deterministic. */
export function consistencyValues(transcripts: TranscriptSamples[], k: number): ConsistencyValues {
  const stats: TranscriptStats[] = [];
  for (const t of transcripts) {
    const valid = t.samples.filter((s): s is NonNullable<Sample> => s !== null);
    if (valid.length < 2) continue;
    const scores = valid.map((s) => s.score);
    stats.push({
      id: t.id,
      expected: t.expected,
      valid: valid.length,
      scoreMean: mean(scores),
      scoreStd: std(scores),
      scoreRange: range(scores),
      rating: agreement(valid.map((s) => s.rating)),
      guidance: agreement(valid.map((s) => s.guidance)),
      discrepancy: agreement(valid.map((s) => s.discrepancy)),
    });
  }
  const all = transcripts.flatMap((t) => t.samples);
  const avg = (pick: (s: TranscriptStats) => number) => (stats.length > 0 ? mean(stats.map(pick)) : null);
  const classMean = (expected: Expected) => {
    const scores = stats.filter((s) => s.expected === expected).map((s) => s.scoreMean);
    return scores.length > 0 ? mean(scores) : null;
  };
  const strong = classMean("strong");
  const weak = classMean("weak");
  return {
    k,
    transcripts: stats,
    measured: stats.length,
    validRate: all.length > 0 ? all.filter((s) => s !== null).length / all.length : 0,
    scoreStd: avg((s) => s.scoreStd),
    scoreRange: avg((s) => s.scoreRange),
    ratingAgreement: avg((s) => s.rating.share),
    guidanceAgreement: avg((s) => s.guidance.share),
    discrepancyAgreement: avg((s) => s.discrepancy.share),
    separation: strong !== null && weak !== null ? { strong, weak, value: strong - weak } : null,
  };
}

export interface ConsistencyInput {
  corpusId: string;
  values: ConsistencyValues;
  transcripts: TranscriptSamples[];
  replay: ReplayCheck;
  mode: RunEnv["mode"];
  model: { model: string; reasoningEffort?: string };
  seed: number;
  gate: boolean;
}

const fmt = (x: number) => x.toFixed(2);

/** Metrics, cases and caveats; throws when the strong-above-weak sanity check fails. */
export function consistencyResult(input: ConsistencyInput): SuiteResult {
  const { corpusId, values, seed } = input;
  const caveats: string[] = [];
  const metrics: Metric[] = [];
  const when = input.replay.status === "ok"
    ? `recorded ${input.replay.recordedAt.slice(0, 10)}`
    : input.mode === "live"
    ? "live run, not recorded"
    : "recording date unknown";
  const source = `${input.model.model} (reasoning ${input.model.reasoningEffort ?? "default"}), K=${values.k}, ${when}; describes the model as of those samples, not now`;

  const sep = values.separation;
  if (sep && sep.value < MIN_SEPARATION) {
    throw new Error(
      `strong-above-weak sanity check failed for ${corpusId}: strong transcripts average ${fmt(sep.strong)}, weak ${fmt(sep.weak)} ` +
        `(need a gap of at least ${MIN_SEPARATION}). Constant or label-blind output would look perfectly consistent, so these samples are not used.`,
    );
  }

  const perTranscript = (pick: (s: TranscriptStats) => number) => values.transcripts.map(pick);
  const model = (id: string, label: string, value: number | null, per: number[], extra: Pick<Metric, "direction" | "gate">) => {
    if (value === null) return;
    metrics.push({
      id: `consistency.${corpusId}.model.${id}`,
      label: `${label} (${corpusId})`,
      value,
      n: per.length,
      ci: bootstrapCI(per, { seed }),
      provenance: "recorded_live",
      corpus: corpusId,
      note: source,
      ...extra,
    });
  };
  model("score_std", "Score standard deviation across K samples, mean over transcripts", values.scoreStd, perTranscript((s) => s.scoreStd), {
    direction: "lower_is_better",
    gate: input.gate,
  });
  model("score_range", "Score range across K samples, mean over transcripts", values.scoreRange, perTranscript((s) => s.scoreRange), {
    direction: "lower_is_better",
    gate: false,
  });
  model("rating_agreement", "Modal rating agreement across K samples", values.ratingAgreement, perTranscript((s) => s.rating.share), {
    direction: "higher_is_better",
    gate: input.gate,
  });
  model("guidance_agreement", "Modal guidance agreement across K samples", values.guidanceAgreement, perTranscript((s) => s.guidance.share), {
    direction: "higher_is_better",
    gate: input.gate,
  });
  model("discrepancy_agreement", "Discrepancy-flag agreement across K samples", values.discrepancyAgreement, perTranscript((s) => s.discrepancy.share), {
    direction: "higher_is_better",
    gate: input.gate,
  });
  if (sep) {
    metrics.push({
      id: `consistency.${corpusId}.model.score_separation`,
      label: `Mean score, strong minus weak transcripts (${corpusId})`,
      value: sep.value,
      n: values.transcripts.filter((s) => s.expected !== "mixed").length,
      direction: "higher_is_better",
      provenance: "recorded_live",
      corpus: corpusId,
      gate: false,
      note: `sanity check, must be >= ${MIN_SEPARATION}: strong ${fmt(sep.strong)}, weak ${fmt(sep.weak)}; ${source}`,
    });
  }
  const sampleCount = input.transcripts.reduce((n, t) => n + t.samples.length, 0);
  if (sampleCount > 0) {
    metrics.push({
      id: `consistency.${corpusId}.model.valid_output_rate`,
      label: `Samples with valid evaluation output (${corpusId})`,
      value: values.validRate,
      n: sampleCount,
      direction: "higher_is_better",
      provenance: "recorded_live",
      corpus: corpusId,
      gate: false,
      note: source,
    });
  }
  if (input.replay.status === "ok") {
    metrics.push({
      id: `consistency.${corpusId}.replay.reproducibility`,
      label: `Replay reproduces record-time consistency values (${corpusId})`,
      value: 1,
      n: values.measured,
      direction: "higher_is_better",
      provenance: "replay_reproducibility",
      corpus: corpusId,
      gate: input.gate,
      note: "two passes over the stored K samples agree byte for byte and equal the values stored at record time; a pipeline check that says nothing about the model's current variability",
    });
  }

  const unrecorded = input.transcripts.filter((t) => !t.recorded).length;
  if (values.measured === 0) {
    caveats.push(`model consistency not measured for ${corpusId}: no transcript has two valid samples${unrecorded > 0 ? ' (samples are not recorded; run "eval record" with OPENAI_API_KEY)' : ""}.`);
  } else if (unrecorded > 0) {
    caveats.push(`partial: ${unrecorded} of ${input.transcripts.length} transcripts are missing recorded samples, so the metrics cover only part of the dataset.`);
  }
  if (input.replay.status === "skipped") caveats.push(`replay reproducibility not checked: ${input.replay.reason}.`);
  if (input.replay.status === "missing") caveats.push('replay reproducibility not checked: the record-time summary is not recorded for these samples; run "eval record".');
  if (!sep) caveats.push("strong-above-weak sanity check not run: no measured strong or no measured weak transcript.");
  const thin = input.transcripts.filter((t) => t.recorded && t.samples.filter((s) => s !== null).length < 2).length;
  if (thin > 0) caveats.push(`${thin} transcript(s) have fewer than two valid samples and are excluded from the consistency metrics.`);
  caveats.push(
    `Each transcript is one scripted turn evaluated from a fresh interview state, as ${values.k} separate requests; the spoken Realtime interviewer is not evaluated.`,
  );

  const statsById = new Map(values.transcripts.map((s) => [s.id, s]));
  const cases = input.transcripts.map((t) => {
    const s = statsById.get(t.id);
    const scores = t.samples.map((x) => (x ? String(x.score) : "invalid")).join(",");
    const detail = s
      ? `expected ${t.expected}; scores [${scores}]; mean ${fmt(s.scoreMean)}, std ${fmt(s.scoreStd)}; rating ${s.rating.mode} ${fmt(s.rating.share)}; guidance ${s.guidance.mode} ${
        fmt(s.guidance.share)
      }; discrepancy ${s.discrepancy.mode} ${fmt(s.discrepancy.share)}`
      : `expected ${t.expected}; ${t.recorded ? `fewer than two valid samples [${scores}]` : `not recorded (${t.samples.length} of ${values.k} samples)`}`;
    return { id: `transcript/${t.id}`, ok: s !== undefined, detail };
  });
  return { metrics, cases, caveats };
}

async function mapLimited<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(SAMPLE_CONCURRENCY, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]);
    }
  }));
  return out;
}
