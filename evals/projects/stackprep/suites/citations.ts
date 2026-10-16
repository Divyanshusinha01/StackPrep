/**
 * Citation validity on one corpus: does every file, module, line range and identifier that the text
 * pipeline cites exist at the pinned commit? Deterministic over the recorded pipeline outputs (plan,
 * answer evaluations, report), and reported before and after `groundReport` to show what it catches.
 * Validity is existence only; whether the cited code supports the claim is the support suite's metric.
 */
import { bootstrapCI } from "../../../core/stats.ts";
import type { Metric, Suite, SuiteResult } from "../../../core/types.ts";
import { type Citation, type Resolution, resolveCitation } from "../src/citations.ts";
import type { IndexedCorpus } from "../src/corpus.ts";
import { type PipelineContext, type PipelineRun, pipelineRun, sessionsPinId } from "../src/sessions.ts";
import { pipelineUnits, SURFACE_LABELS, SURFACES, type Surface, type TextUnit, unitCitations } from "../src/surfaces.ts";

/** Surfaces in the overall number; the ungrounded report is shown only next to the grounded one. */
const OVERALL_SURFACES: readonly Surface[] = ["plan", "evaluation", "report"];
const PARTS = [
  ["path", "path"],
  ["line_range", "lines"],
  ["symbol", "symbol"],
] as const;

export interface CheckedCitation {
  unit: TextUnit;
  citation: Citation;
  resolution: Resolution;
}

export interface CitationCheck {
  checked: CheckedCitation[];
  /** Reference units (repo_evidence items) naming no file, module or identifier, e.g. a technology. */
  uncitedReferences: TextUnit[];
  references: number;
}

/** Extracts and resolves every citation in the units. */
export function checkCitations(units: readonly TextUnit[], corpus: IndexedCorpus): CitationCheck {
  const paths = [...corpus.files.keys()];
  const out: CitationCheck = { checked: [], uncitedReferences: [], references: 0 };
  for (const unit of units) {
    const citations = unitCitations(unit, paths);
    if (unit.role === "reference") {
      out.references++;
      if (citations.length === 0) out.uncitedReferences.push(unit);
    }
    for (const citation of citations) out.checked.push({ unit, citation, resolution: resolveCitation(corpus, citation) });
  }
  return out;
}

export interface CitationsSuiteOptions {
  /** Whether the overall validity gates CI. Everything else is informational. */
  gate: boolean;
}

export function citationsSuite(corpusId: string, options: CitationsSuiteOptions): Suite<PipelineContext> {
  return {
    id: `citations-${corpusId}`,
    pins: [corpusId, sessionsPinId(corpusId)],
    run: async (ctx, env) => {
      const corpus = ctx.corpora.get(corpusId);
      if (!corpus) throw new Error(`corpus "${corpusId}" is not loaded`);
      return citationResult(corpus, await pipelineRun(ctx, corpusId, env), env.seed, options);
    },
  };
}

/** Metrics, cases and caveats for one pipeline run. */
export function citationResult(corpus: IndexedCorpus, run: PipelineRun, seed: number, options: CitationsSuiteOptions): SuiteResult {
  const check = checkCitations(pipelineUnits(run), corpus);
  const caveats: string[] = [];
  const metric = (id: string, label: string, values: number[], gate: boolean, extra: Partial<Metric> = {}): Metric => ({
    id: `citations.${corpus.id}.${id}`,
    label: `${label} (${corpus.id})`,
    value: values.reduce((a, b) => a + b, 0) / values.length,
    n: values.length,
    ci: bootstrapCI(values, { seed }),
    direction: "higher_is_better",
    provenance: "deterministic",
    corpus: corpus.id,
    gate,
    note: "deterministic check over recorded model outputs",
    ...extra,
  });
  const validity = (items: CheckedCitation[]) => items.map((c) => (c.resolution.valid ? 1 : 0));

  const metrics: Metric[] = [];
  const overall = check.checked.filter((c) => OVERALL_SURFACES.includes(c.unit.surface));
  if (overall.length > 0) {
    metrics.push(metric("validity", "Citation validity", validity(overall), options.gate));
    for (const [id, part] of PARTS) {
      const values = overall.flatMap((c) => (c.resolution.checks[part] === undefined ? [] : [c.resolution.checks[part] ? 1 : 0]));
      if (values.length > 0) metrics.push(metric(`validity.${id}`, `Citation validity, ${id.replace("_", " ")}s`, values, false));
    }
  }
  for (const surface of SURFACES) {
    const items = check.checked.filter((c) => c.unit.surface === surface);
    if (items.length > 0) metrics.push(metric(`validity.${surface}`, `Citation validity, ${SURFACE_LABELS[surface]}`, validity(items), false));
  }
  if (check.references > 0) {
    const uncited = check.uncitedReferences.length;
    const values = Array.from({ length: check.references }, (_, i) => (i < uncited ? 1 : 0));
    metrics.push(metric("uncited_references", "repo_evidence items naming no file, module or identifier", values, false, {
      direction: "lower_is_better",
      note: "technologies and prose in repo_evidence; not wrong, but not checkable",
    }));
  }

  if (metrics.length === 0) {
    caveats.push(`citation validity not measured: no pipeline output is available for ${corpus.id}; run "eval record" with OPENAI_API_KEY, then re-pin recordings.`);
  } else if (run.partial) {
    caveats.push(`partial: ${run.problems.filter((p) => p.reason === "not_recorded").length} pipeline output(s) are not recorded, so these numbers cover only part of the sessions.`);
  }
  if (check.checked.length > 0 && check.checked.every((c) => !OVERALL_SURFACES.includes(c.unit.surface))) {
    caveats.push("Only the ungrounded report has citations; the overall number is not reported.");
  }
  caveats.push(...groundingCaveats(corpus, run, check));
  caveats.push(
    "Identifiers missing from the code index (for example in files the production secret check withholds) count as valid when they occur as a whole word in the corpus.",
    "Validity is existence at the pinned commit, not support: see the support suite for whether the cited code backs the claim.",
    "The live voice interviewer's spoken questions are not measured; the plan's opening question and topics stand in for interviewer-facing text.",
  );

  const cases = [
    ...run.problems.map((p) => ({ id: `pipeline/${p.at}`, ok: false, detail: `${p.stage} ${p.reason}: ${p.detail}` })),
    ...check.checked.flatMap((c, i) =>
      c.resolution.valid ? [] : [{
        id: `invalid/${c.unit.surface}/${c.unit.at}/${c.unit.field}#${i}`,
        ok: false,
        detail: `"${c.citation.raw}": ${c.resolution.reason}`,
      }]
    ),
  ];
  return { metrics, cases, caveats };
}

/** What `groundReport` removed, and what it cannot see. */
function groundingCaveats(corpus: IndexedCorpus, run: PipelineRun, check: CitationCheck): string[] {
  const reports = run.sessions.flatMap((s) => (s.report ? [s.report] : []));
  if (reports.length === 0) return [];
  let entries = 0;
  let removed = 0;
  let removedInvalid = 0;
  for (const { ungrounded, grounded } of reports) {
    entries += ungrounded.repository_evidence.length;
    const kept = new Set(grounded.repository_evidence.map((e) => `${e.path}\n${e.note}`));
    for (const e of ungrounded.repository_evidence) {
      if (kept.has(`${e.path}\n${e.note}`)) continue;
      removed++;
      const path = e.path.trim().replace(/^\.\//, "");
      if (!corpus.files.has(path) && ![...corpus.files.keys()].some((p) => p.startsWith(`${path.replace(/\/$/, "")}/`))) removedInvalid++;
    }
  }
  const remaining = check.checked.filter((c) => c.unit.surface === "report" && !c.resolution.valid);
  const outsideEvidence = remaining.filter((c) => !c.unit.field.startsWith("report.repository_evidence")).length;
  return [
    `groundReport removed ${removed} of ${entries} repository_evidence entries across ${reports.length} report(s); ${removedInvalid} of the removed entries cited paths that do not exist.`,
    `groundReport checks only repository_evidence paths: ${remaining.length} invalid citation(s) remain in the saved reports, ${outsideEvidence} of them in other fields (narratives, gaps, question reviews).`,
  ];
}
