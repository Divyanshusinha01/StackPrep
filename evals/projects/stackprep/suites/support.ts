/**
 * Claim support on one corpus: does the cited code support the claim made next to it? The unit is a
 * (claim, cited span) pair from the recorded pipeline outputs; only valid file-level citations form
 * pairs. Two independent checks, reported as separate metrics and never as citation validity:
 * - anchors: human labels whose regular-expression anchors must hold on the pinned span;
 * - judge: a recorded model judge, with its precision and recall against human labels beside it.
 */
import { AIInvalidOutputError } from "../../../../supabase/functions/_shared/ai/provider.ts";
import { ReplayMissError } from "../../../core/recording.ts";
import { bootstrapCI } from "../../../core/stats.ts";
import type { Metric, Suite, SuiteResult } from "../../../core/types.ts";
import { recordedAIProvider } from "../src/ai.ts";
import { type ClaimPair, claimPairs, claimsPinId, loadClaims, type ResolvedClaims, spanCitation } from "../src/claims.ts";
import type { Span } from "../src/citations.ts";
import { calibrate, type JudgeCalibration, type JudgeFloor, judgePair, type JudgeVerdict } from "../src/judge.ts";
import type { TaskModel } from "../src/planning.ts";
import { type PipelineContext, pipelineRun, scopedRecorder, sessionsPinId } from "../src/sessions.ts";
import { pipelineUnits, SURFACE_LABELS, type Surface } from "../src/surfaces.ts";

/** Judge calls in flight at once when recording. */
const JUDGE_CONCURRENCY = 6;

export interface SupportSettings {
  judge: TaskModel;
  /** Below it, judged metrics are informational. */
  floor: JudgeFloor;
}

export interface SupportContext extends PipelineContext {
  support: SupportSettings;
}

export interface SupportSuiteOptions {
  /** Whether the overall support metrics may gate CI (the judged one only while the judge meets the floor). */
  gate: boolean;
}

export function supportSuite(corpusId: string, options: SupportSuiteOptions): Suite<SupportContext> {
  return {
    id: `support-${corpusId}`,
    pins: [corpusId, sessionsPinId(corpusId), claimsPinId(corpusId)],
    run: async (ctx, env) => {
      const corpus = ctx.corpora.get(corpusId);
      if (!corpus) throw new Error(`corpus "${corpusId}" is not loaded`);
      const claims = await loadClaims(ctx.projectDir, corpus);
      const run = await pipelineRun(ctx, corpusId, env);
      const extraction = await claimPairs(pipelineUnits(run), corpus);
      // Keyed on the corpus only: editing labels or sessions must not re-record judgements of unchanged pairs.
      const judgeAI = recordedAIProvider(scopedRecorder(env.recorder, [corpusId]), { provider: ctx.liveAI });
      const judge = async (claim: string, span: Span): Promise<Judged> => {
        try {
          return { verdict: await judgePair(judgeAI, ctx.support.judge, claim, span) };
        } catch (err) {
          if (err instanceof ReplayMissError) return { missing: "not_recorded" };
          if (err instanceof AIInvalidOutputError) return { missing: "invalid_output" };
          throw err;
        }
      };
      const calibrationVerdicts = await mapLimited(claims.calibration, (p) => judge(p.claim, p.span));
      const pairVerdicts = await mapLimited(extraction.pairs, (p) => judge(p.claim, p.span));
      return supportResult({
        corpusId,
        claims,
        pairs: extraction.pairs,
        calibrationVerdicts,
        pairVerdicts,
        claimCitations: extraction.claimCitations,
        validClaimCitations: extraction.validClaimCitations,
        moduleCitations: extraction.moduleCitations,
        problems: run.problems,
        partial: run.partial,
        floor: ctx.support.floor,
        seed: env.seed,
        gate: options.gate,
      });
    },
  };
}

export type Judged = { verdict: JudgeVerdict; missing?: undefined } | { verdict?: undefined; missing: "not_recorded" | "invalid_output" };

export interface SupportInput {
  corpusId: string;
  claims: ResolvedClaims;
  pairs: ClaimPair[];
  calibrationVerdicts: Judged[];
  pairVerdicts: Judged[];
  claimCitations: number;
  validClaimCitations: number;
  moduleCitations: number;
  problems: Array<{ at: string; stage: string; reason: string; detail: string }>;
  partial: boolean;
  floor: JudgeFloor;
  seed: number;
  gate: boolean;
}

const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
const fmt = (x: number | null) => (x === null ? "n/a" : x.toFixed(2));

/** Metrics, cases and caveats from judged pairs; pure, so tests can feed verdicts directly. */
export function supportResult(input: SupportInput): SuiteResult {
  const { corpusId, claims, pairs, seed } = input;
  const caveats: string[] = [];
  const metrics: Metric[] = [];
  const metric = (id: string, label: string, values: number[], extra: Partial<Metric> & Pick<Metric, "provenance" | "gate">): Metric => ({
    id: `support.${corpusId}.${id}`,
    label: `${label} (${corpusId})`,
    value: values.reduce((a, b) => a + b, 0) / values.length,
    n: values.length,
    ci: bootstrapCI(values, { seed }),
    direction: "higher_is_better",
    corpus: corpusId,
    ...extra,
  });

  // Judge calibration: hand-written calibration pairs plus labelled pipeline pairs with a code claim.
  const labelled = pairs.map((p) => claims.labels.get(p.key));
  const calibrationRows: Array<{ verdict: JudgeVerdict["verdict"]; supported: boolean }> = [];
  claims.calibration.forEach((p, i) => {
    const v = input.calibrationVerdicts[i].verdict;
    if (v) calibrationRows.push({ verdict: v.verdict, supported: p.supported });
  });
  pairs.forEach((_, i) => {
    const label = labelled[i];
    const v = input.pairVerdicts[i].verdict;
    if (v && label && label.supported !== null) calibrationRows.push({ verdict: v.verdict, supported: label.supported });
  });
  const calibration: JudgeCalibration | null = calibrate(calibrationRows, input.floor);
  const judgeNote = calibration
    ? `judge precision ${fmt(calibration.confusion.precision)}, recall ${fmt(calibration.confusion.recall)} at flagging unsupported claims (n=${calibration.confusion.n})`
    : "judge not calibrated: no judged labelled pairs";
  if (calibration) {
    const { confusion: c } = calibration;
    const judged = (id: string, label: string, value: number | null, n: number) => {
      if (value === null) return;
      metrics.push({
        id: `support.${corpusId}.judge.${id}`,
        label: `${label} (${corpusId})`,
        value,
        n,
        direction: "higher_is_better",
        provenance: "judged",
        corpus: corpusId,
        gate: false,
        note: "judge against human labels; positive class: unsupported claim",
      });
    };
    judged("precision", "Judge precision at flagging unsupported claims", c.precision, c.tp + c.fp);
    judged("recall", "Judge recall of unsupported claims", c.recall, c.tp + c.fn);
    judged("agreement", "Judge agreement with human labels", c.accuracy, c.n);
    if (!calibration.meetsFloor) {
      caveats.push(
        `The judge is below the floor (precision and recall >= ${input.floor.precision}/${input.floor.recall} over >= ${input.floor.n} labelled pairs; ${judgeNote}), so judged support is informational.`,
      );
    }
  }

  // Claim support over pipeline pairs.
  const anchorValues = labelled.flatMap((label) => (label && label.supported !== null ? [label.supported ? 1 : 0] : []));
  if (anchorValues.length > 0) {
    metrics.push(metric("claim_support.anchors", "Claim support, human-labelled anchors", anchorValues, {
      provenance: "deterministic",
      gate: input.gate,
      note: "labelled pipeline pairs; anchors re-checked against the pinned code on every run",
    }));
  }
  const judgedPairs = pairs.flatMap((p, i) => {
    const v = input.pairVerdicts[i].verdict;
    return v && v.verdict !== "no_code_claim" ? [{ pair: p, supported: v.verdict === "supported" }] : [];
  });
  if (judgedPairs.length > 0) {
    metrics.push(metric("claim_support.judge", "Claim support, judge", judgedPairs.map((j) => (j.supported ? 1 : 0)), {
      provenance: "judged",
      gate: input.gate && calibration !== null && calibration.meetsFloor,
      note: judgeNote,
    }));
    for (const surface of ["plan", "evaluation", "report"] as Surface[]) {
      const values = judgedPairs.filter((j) => j.pair.surface === surface).map((j) => (j.supported ? 1 : 0));
      if (values.length > 0) {
        metrics.push(metric(`claim_support.judge.${surface}`, `Claim support, judge, ${SURFACE_LABELS[surface]}`, values, {
          provenance: "judged",
          gate: false,
          note: judgeNote,
        }));
      }
    }
  }
  if (pairs.length > 0) {
    metrics.push(metric("labelled_coverage", "Pipeline pairs with a human label", labelled.map((l) => (l ? 1 : 0)), {
      provenance: "deterministic",
      gate: false,
      note: "unlabelled pairs are listed in the cases for labelling",
    }));
  }

  // Caveats: coverage, the validity-versus-support gap, and what was not measured.
  if (pairs.length === 0) {
    caveats.push(`claim support not measured: the pipeline produced no claim with a valid file citation for ${corpusId}${input.partial ? " (pipeline outputs are not recorded; run \"eval record\")" : ""}.`);
  } else if (input.partial) {
    caveats.push("partial: some pipeline outputs are not recorded, so the pairs cover only part of the sessions.");
  }
  if (input.claimCitations > 0 && judgedPairs.length > 0) {
    const supportedShare = judgedPairs.filter((j) => j.supported).length / judgedPairs.length;
    caveats.push(
      `Validity versus support: ${pct(input.validClaimCitations / input.claimCitations)} of ${input.claimCitations} citations made by claims are valid, but the judge finds only ${pct(supportedShare)} of ${judgedPairs.length} judged pairs supported.`,
    );
  }
  if (input.moduleCitations > 0) caveats.push(`${input.moduleCitations} valid claim citation(s) name a directory, which has no span to judge; they form no pairs.`);
  const unlabelled = labelled.filter((l) => !l).length;
  if (unlabelled > 0) caveats.push(`${unlabelled} of ${pairs.length} pipeline pairs have no human label; label them in datasets/claims/${corpusId}.json from the "pair/" cases.`);
  const current = new Set(pairs.map((p) => p.key));
  const stale = [...claims.labels.keys()].filter((k) => !current.has(k)).length;
  if (stale > 0) caveats.push(`${stale} label(s) match no current pipeline pair (the recorded text changed); they are unused and can be removed.`);
  const missingJudge = [...input.calibrationVerdicts, ...input.pairVerdicts].filter((j) => j.missing === "not_recorded").length;
  if (missingJudge > 0) caveats.push(`judge not measured for ${missingJudge} pair(s): judgements are not recorded; run "eval record" with OPENAI_API_KEY.`);
  const invalidJudge = [...input.calibrationVerdicts, ...input.pairVerdicts].filter((j) => j.missing === "invalid_output").length;
  if (invalidJudge > 0) caveats.push(`the judge returned invalid output for ${invalidJudge} pair(s); they are excluded.`);
  const noCodeClaim = input.pairVerdicts.filter((j) => j.verdict?.verdict === "no_code_claim").length;
  if (noCodeClaim > 0) caveats.push(`the judge found no code claim in ${noCodeClaim} pipeline pair(s); they are excluded from judged support.`);
  caveats.push("The judge sees the claim and the cited span only; whole-file citations are cut at 300 lines.");

  const verdictText = (j: Judged) => (j.verdict ? `${j.verdict.verdict} (${j.verdict.reason})` : j.missing);
  const cases = [
    ...input.problems.map((p) => ({ id: `pipeline/${p.at}`, ok: false, detail: `${p.stage} ${p.reason}: ${p.detail}` })),
    ...claims.calibration.map((p, i) => {
      const j = input.calibrationVerdicts[i];
      const ok = j.verdict !== undefined && (j.verdict.verdict === "supported") === p.supported;
      return { id: `calibration/${p.id}`, ok, detail: `${p.kind}, label supported=${p.supported}; judge ${verdictText(j)}` };
    }),
    ...pairs.map((p, i) => {
      const label = labelled[i];
      const j = input.pairVerdicts[i];
      const ok = label ? label.supported !== false : j.verdict?.verdict !== "unsupported";
      const labelText = label ? `label supported=${label.supported}` : "UNLABELLED";
      return {
        id: `pair/${p.key}`,
        ok,
        detail: `${p.at} ${p.field}; ${labelText}; judge ${verdictText(j)}; citation "${spanCitation(p.span)}"; claim "${p.claim}"`,
      };
    }),
  ];
  return { metrics, cases, caveats };
}

async function mapLimited<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(JUDGE_CONCURRENCY, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]);
    }
  }));
  return out;
}
