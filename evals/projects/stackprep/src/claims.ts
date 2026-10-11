/**
 * Claim support units and their human labels. A pair is (claim text, cited span at the pinned commit);
 * only valid, file-level citations form pairs, since an invalid citation has no span to support anything.
 *
 * Labels carry anchors: regular expressions the span must (or, for absence anchors such as a missing
 * guard, must not) match for the claim to hold. Every labelled verdict must agree with its anchors on
 * the pinned code, so a corpus change that breaks a label fails validation instead of silently scoring.
 *
 * The dataset has two parts:
 * - calibration: hand-written pairs, including real paths with wrong claims and real symbols with
 *   invented behaviour, used to measure the judge;
 * - labels: verdicts for pairs the recorded pipeline produced, keyed by pair key. Pipeline pairs
 *   without a label are counted and listed for labelling, never guessed.
 */
import { hashCanonical } from "../../../core/keys.ts";
import type { PinSpec } from "../../../core/types.ts";
import {
  type Anchor,
  anchorProblems,
  anchorsHold,
  type Citation,
  citationSpan,
  extractCitations,
  resolveCitation,
  type Span,
  strictPathCitation,
} from "./citations.ts";
import type { IndexedCorpus } from "./corpus.ts";
import { claimCitations, type Surface, type TextUnit } from "./surfaces.ts";

export const CLAIMS_DATASET_FORMAT = 1;
export const CALIBRATION_KINDS = ["supported", "supported_absence", "wrong_claim", "invented_behaviour"] as const;
export type CalibrationKind = typeof CALIBRATION_KINDS[number];
/** Surfaces whose claims are paired; the ungrounded report is only a citation-validity comparison. */
export const CLAIM_SURFACES: readonly Surface[] = ["plan", "evaluation", "report"];

export interface CalibrationPair {
  id: string;
  kind: CalibrationKind;
  claim: string;
  /** One citation in any form the extractor reads, e.g. "src/a.ts:3-9" or "src/a.ts (login)". */
  citation: string;
  supported: boolean;
  anchors: Anchor[];
}

export interface PairLabel {
  /** Pair key, from the unlabelled-pair listing. */
  key: string;
  /** Copied from the listing; the key is recomputed from it. */
  claim: string;
  /** "path:start-end" of the span, copied from the listing. */
  citation: string;
  /** Null when the text states no fact about the code (excluded from support rates). */
  supported: boolean | null;
  anchors: Anchor[];
  note?: string;
}

export interface ClaimsDataset {
  format: number;
  corpus: string;
  guidelines: string[];
  calibration: CalibrationPair[];
  labels: PairLabel[];
}

export interface ClaimPair {
  key: string;
  surface: Surface;
  at: string;
  field: string;
  claim: string;
  citation: Citation;
  span: Span;
}

export interface ResolvedCalibration extends CalibrationPair {
  key: string;
  span: Span;
}

export interface ResolvedLabel extends PairLabel {
  span: Span;
}

export interface ResolvedClaims {
  dataset: ClaimsDataset;
  calibration: ResolvedCalibration[];
  labels: Map<string, ResolvedLabel>;
}

export const claimsPath = (corpusId: string) => `datasets/claims/${corpusId}.json`;
export const claimsPinId = (corpusId: string) => `dataset.claims.${corpusId}`;

export function claimsDatasetPins(corpusIds: readonly string[]): PinSpec[] {
  return corpusIds.map((id) => ({ id: claimsPinId(id), kind: "dataset", files: [claimsPath(id)] }));
}

export async function pairKey(claim: string, span: Pick<Span, "path" | "start" | "end">): Promise<string> {
  return (await hashCanonical({ claim: claim.trim(), path: span.path, start: span.start, end: span.end })).slice(0, 16);
}

/** "path:start-end", the citation form labels use. */
export function spanCitation(span: Pick<Span, "path" | "start" | "end">): string {
  return `${span.path}:${span.start}-${span.end}`;
}

function spanOf(corpus: IndexedCorpus, citation: Citation): { span?: Span; problem?: string } {
  const resolution = resolveCitation(corpus, citation);
  if (!resolution.valid) return { problem: `citation "${citation.raw}" is invalid: ${resolution.reason}` };
  const span = citationSpan(corpus, citation, resolution);
  return span ? { span } : { problem: `citation "${citation.raw}" names a module, which has no span` };
}

/** Resolves and checks the dataset against the corpus; problems make it unusable. */
export async function resolveClaims(dataset: ClaimsDataset, corpus: IndexedCorpus): Promise<{ resolved?: ResolvedClaims; problems: string[] }> {
  const problems: string[] = [];
  if (dataset.format !== CLAIMS_DATASET_FORMAT) problems.push(`format must be ${CLAIMS_DATASET_FORMAT}`);
  if (dataset.corpus !== corpus.id) problems.push(`dataset is for corpus "${dataset.corpus}", not "${corpus.id}"`);
  if (!Array.isArray(dataset.calibration) || !Array.isArray(dataset.labels)) return { problems: [...problems, "calibration and labels must be arrays"] };
  const paths = [...corpus.files.keys()];

  const calibration: ResolvedCalibration[] = [];
  const ids = new Set<string>();
  for (const pair of dataset.calibration) {
    const at = `calibration ${pair.id}`;
    if (!pair.id || ids.has(pair.id)) problems.push(`${at}: missing or duplicate id`);
    ids.add(pair.id);
    if (!CALIBRATION_KINDS.includes(pair.kind)) problems.push(`${at}: kind must be one of ${CALIBRATION_KINDS.join(", ")}`);
    if (typeof pair.supported !== "boolean") problems.push(`${at}: supported must be true or false`);
    if (pair.kind?.startsWith("supported") !== (pair.supported === true)) problems.push(`${at}: kind ${pair.kind} disagrees with supported=${pair.supported}`);
    if (!pair.claim?.trim()) problems.push(`${at}: empty claim`);
    const citations = extractCitations(pair.citation ?? "", paths);
    if (citations.length !== 1) {
      problems.push(`${at}: citation "${pair.citation}" must hold exactly one citation, found ${citations.length}`);
      continue;
    }
    const { span, problem } = spanOf(corpus, citations[0]);
    if (!span) {
      problems.push(`${at}: ${problem}`);
      continue;
    }
    problems.push(...labelProblems(at, pair.supported, pair.anchors, span));
    calibration.push({ ...pair, key: await pairKey(pair.claim, span), span });
  }

  const labels = new Map<string, ResolvedLabel>();
  for (const label of dataset.labels) {
    const at = `label ${label.key}`;
    if (labels.has(label.key)) problems.push(`${at}: duplicate key`);
    const { span, problem } = spanOf(corpus, strictPathCitation(label.citation ?? ""));
    if (!span) {
      problems.push(`${at}: ${problem}`);
      continue;
    }
    const key = await pairKey(label.claim ?? "", span);
    if (key !== label.key) problems.push(`${at}: claim and citation hash to ${key}; copy both from the unlabelled-pair listing`);
    if (label.supported === null) {
      problems.push(...anchorProblems(label.anchors ?? []).map((p) => `${at}: ${p}`));
    } else {
      problems.push(...labelProblems(at, label.supported, label.anchors, span));
    }
    labels.set(label.key, { ...label, span });
  }

  return problems.length > 0 ? { problems } : { resolved: { dataset, calibration, labels }, problems };
}

function labelProblems(at: string, supported: boolean, anchors: Anchor[] | undefined, span: Span): string[] {
  if (!Array.isArray(anchors) || anchors.length === 0) return [`${at}: a labelled verdict needs at least one anchor`];
  const bad = anchorProblems(anchors);
  if (bad.length > 0) return bad.map((p) => `${at}: ${p}`);
  const holds = anchorsHold(anchors, span.text);
  return holds === supported
    ? []
    : [`${at}: anchors ${holds ? "hold" : "fail"} on ${spanCitation(span)} but the label says supported=${supported}; fix the label or the anchors`];
}

export async function loadClaims(projectDir: URL, corpus: IndexedCorpus): Promise<ResolvedClaims> {
  const path = claimsPath(corpus.id);
  const dataset = JSON.parse(await Deno.readTextFile(new URL(path, projectDir))) as ClaimsDataset;
  const { resolved, problems } = await resolveClaims(dataset, corpus);
  if (!resolved) throw new Error(`${path}: ${problems.join("; ")}`);
  return resolved;
}

export interface PairExtraction {
  pairs: ClaimPair[];
  /** Citations made by claim units (own and bound), and how many were valid. */
  claimCitations: number;
  validClaimCitations: number;
  /** Valid citations of a directory, which have no span to judge. */
  moduleCitations: number;
}

/** Claim pairs of the claim units on the claim surfaces, de-duplicated by key in order of appearance. */
export async function claimPairs(units: readonly TextUnit[], corpus: IndexedCorpus): Promise<PairExtraction> {
  const paths = [...corpus.files.keys()];
  const seen = new Set<string>();
  const out: PairExtraction = { pairs: [], claimCitations: 0, validClaimCitations: 0, moduleCitations: 0 };
  for (const unit of units) {
    if (unit.role !== "claim" || !CLAIM_SURFACES.includes(unit.surface)) continue;
    for (const citation of claimCitations(unit, paths)) {
      out.claimCitations++;
      const resolution = resolveCitation(corpus, citation);
      if (!resolution.valid) continue;
      out.validClaimCitations++;
      const span = citationSpan(corpus, citation, resolution);
      if (!span) {
        out.moduleCitations++;
        continue;
      }
      const key = await pairKey(unit.text, span);
      if (seen.has(key)) continue;
      seen.add(key);
      out.pairs.push({ key, surface: unit.surface, at: unit.at, field: unit.field, claim: unit.text.trim(), citation, span });
    }
  }
  return out;
}
