import { canonicalJson } from "./keys.ts";

function requireValues(values: readonly number[], fn: string): void {
  if (values.length === 0) throw new RangeError(`${fn}: no values`);
  for (const v of values) {
    if (!Number.isFinite(v)) throw new RangeError(`${fn}: non-finite value ${v}`);
  }
}

export function mean(values: readonly number[]): number {
  requireValues(values, "mean");
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** Sample standard deviation (n - 1 denominator). A single value has no spread and returns 0. */
export function std(values: readonly number[]): number {
  requireValues(values, "std");
  if (values.length < 2) return 0;
  const m = mean(values);
  let squares = 0;
  for (const v of values) squares += (v - m) ** 2;
  return Math.sqrt(squares / (values.length - 1));
}

/** max - min. */
export function range(values: readonly number[]): number {
  requireValues(values, "range");
  return Math.max(...values) - Math.min(...values);
}

/**
 * Modal agreement: the share of values equal to the most common value. Values are compared by canonical
 * JSON, so structurally equal objects agree. Ties pick the value whose canonical JSON sorts first.
 */
export function agreement<T>(values: readonly T[]): { mode: T; share: number } {
  if (values.length === 0) throw new RangeError("agreement: no values");
  const counts = new Map<string, { value: T; count: number }>();
  for (const value of values) {
    const key = canonicalJson(value);
    const entry = counts.get(key);
    if (entry) entry.count++;
    else counts.set(key, { value, count: 1 });
  }
  let bestKey = "";
  let best: { value: T; count: number } | undefined;
  for (const [key, entry] of counts) {
    if (!best || entry.count > best.count || (entry.count === best.count && key < bestKey)) {
      best = entry;
      bestKey = key;
    }
  }
  return { mode: best!.value, share: best!.count / values.length };
}

/** Deterministic PRNG (mulberry32) returning floats in [0, 1). The same seed always yields the same sequence. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Linear-interpolated quantile of already sorted values (type 7, the R and NumPy default). */
function quantileSorted(sorted: readonly number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export interface BootstrapOptions {
  seed: number;
  /** Resamples to draw. Default 2000. */
  iterations?: number;
  /** Two-sided confidence level. Default 0.95. */
  level?: number;
  /** Statistic computed on each resample. Default mean. */
  statistic?: (sample: number[]) => number;
}

/** Percentile bootstrap confidence interval. Seeded, so the same inputs always give the same interval. */
export function bootstrapCI(values: readonly number[], options: BootstrapOptions): [number, number] {
  requireValues(values, "bootstrapCI");
  const { seed, iterations = 2000, level = 0.95, statistic = mean } = options;
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new RangeError(`bootstrapCI: iterations must be a positive integer, got ${iterations}`);
  }
  if (!(level > 0 && level < 1)) throw new RangeError(`bootstrapCI: level must be in (0, 1), got ${level}`);
  const random = seededRandom(seed);
  const n = values.length;
  const stats: number[] = new Array(iterations);
  const sample: number[] = new Array(n);
  for (let i = 0; i < iterations; i++) {
    for (let j = 0; j < n; j++) sample[j] = values[Math.floor(random() * n)];
    stats[i] = statistic(sample);
  }
  stats.sort((a, b) => a - b);
  const alpha = (1 - level) / 2;
  return [quantileSorted(stats, alpha), quantileSorted(stats, 1 - alpha)];
}

/** One labelled query: ids in ranked order as returned, and the ids judged relevant. */
export interface RankedCase {
  ranked: readonly string[];
  relevant: readonly string[];
}

function topK(ranked: readonly string[], k: number): string[] {
  // Repeated ids count once, at their first position.
  return [...new Set(ranked)].slice(0, k);
}

function requireCase(c: RankedCase, k: number, fn: string): void {
  if (!Number.isInteger(k) || k < 1) throw new RangeError(`${fn}: k must be a positive integer, got ${k}`);
  if (c.relevant.length === 0) throw new RangeError(`${fn}: case has no relevant ids (unlabelled)`);
}

/** Relevant hits in the top k divided by k. Returning fewer than k results counts as misses. */
export function precisionAtK(c: RankedCase, k: number): number {
  requireCase(c, k, "precisionAtK");
  const relevant = new Set(c.relevant);
  return topK(c.ranked, k).filter((id) => relevant.has(id)).length / k;
}

/** Relevant hits in the top k divided by the number of relevant ids. */
export function recallAtK(c: RankedCase, k: number): number {
  requireCase(c, k, "recallAtK");
  const relevant = new Set(c.relevant);
  return topK(c.ranked, k).filter((id) => relevant.has(id)).length / relevant.size;
}

/** 1 / rank of the first relevant id within the top k, or 0 when none appears. */
export function reciprocalRankAtK(c: RankedCase, k: number): number {
  requireCase(c, k, "reciprocalRankAtK");
  const relevant = new Set(c.relevant);
  const index = topK(c.ranked, k).findIndex((id) => relevant.has(id));
  return index === -1 ? 0 : 1 / (index + 1);
}

export interface RankingAtK {
  k: number;
  precision: number;
  recall: number;
  mrr: number;
  /** Per-case values in input order, for bootstrap intervals and per-case reports. */
  perCase: { precision: number[]; recall: number[]; reciprocalRank: number[] };
}

/** Mean precision@k, recall@k and MRR@k over cases, for each k in ascending order. */
export function rankingMetrics(cases: readonly RankedCase[], ks: readonly number[]): RankingAtK[] {
  if (cases.length === 0) throw new RangeError("rankingMetrics: no cases");
  return [...new Set(ks)].sort((a, b) => a - b).map((k) => {
    const precision = cases.map((c) => precisionAtK(c, k));
    const recall = cases.map((c) => recallAtK(c, k));
    const reciprocalRank = cases.map((c) => reciprocalRankAtK(c, k));
    return {
      k,
      precision: mean(precision),
      recall: mean(recall),
      mrr: mean(reciprocalRank),
      perCase: { precision, recall, reciprocalRank },
    };
  });
}

export interface Confusion {
  n: number;
  tp: number;
  fp: number;
  tn: number;
  fn: number;
  /** tp / (tp + fp); null when nothing was predicted positive. */
  precision: number | null;
  /** tp / (tp + fn); null when there are no actual positives. */
  recall: number | null;
  accuracy: number;
}

/** Binary confusion matrix, e.g. a judge's verdicts against human labels. */
export function confusion(pairs: ReadonlyArray<{ predicted: boolean; actual: boolean }>): Confusion {
  if (pairs.length === 0) throw new RangeError("confusion: no pairs");
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  for (const { predicted, actual } of pairs) {
    if (predicted && actual) tp++;
    else if (predicted) fp++;
    else if (actual) fn++;
    else tn++;
  }
  return {
    n: pairs.length,
    tp,
    fp,
    tn,
    fn,
    precision: tp + fp === 0 ? null : tp / (tp + fp),
    recall: tp + fn === 0 ? null : tp / (tp + fn),
    accuracy: (tp + tn) / pairs.length,
  };
}
