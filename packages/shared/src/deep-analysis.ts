import { z } from "zod";

// Deep repository analysis, stored under `structured.ai` on the analyzed commit's
// `repository_memory` rows. Never sent to clients.

/** Caps enforced when normalizing the provider output, before anything is stored. */
export const DEEP_ANALYSIS_LIMITS = {
  modules: 15,
  decisions: 10,
  securityAreas: 10,
  concepts: 25,
  evidencePerItem: 10,
  summaryChars: 4_000,
  itemChars: 500,
  nameChars: 120,
} as const;

const text = z.string().min(1);
const evidenceFiles = z.array(text);

// Provider output. Objects are strict and every field is required so the schema can be used as an
// OpenAI structured-output schema. Counts and lengths are capped during normalization instead, so
// a slightly long answer is trimmed rather than rejected.

export const deepAnalysisModuleOutputSchema = z.strictObject({
  name: text,
  purpose: text,
  /** Repository paths that evidence the module. */
  evidence_files: evidenceFiles,
});

export const technicalDecisionOutputSchema = z.strictObject({
  decision: text,
  rationale: text,
  evidence_files: evidenceFiles,
});

export const securitySensitiveAreaOutputSchema = z.strictObject({
  area: text,
  reason: text,
  evidence_files: evidenceFiles,
});

export const conceptOutputSchema = z.strictObject({
  term: text,
  explanation: text,
});

export const deepAnalysisOutputSchema = z.strictObject({
  architecture_summary: text,
  important_modules: z.array(deepAnalysisModuleOutputSchema),
  technical_decisions: z.array(technicalDecisionOutputSchema),
  security_sensitive_areas: z.array(securitySensitiveAreaOutputSchema),
  concepts: z.array(conceptOutputSchema),
});

// Normalized result: what is actually stored.

const itemText = z.string().min(1).max(DEEP_ANALYSIS_LIMITS.itemChars);
const nameText = z.string().min(1).max(DEEP_ANALYSIS_LIMITS.nameChars);
const storedEvidence = z.array(z.string().min(1)).max(DEEP_ANALYSIS_LIMITS.evidencePerItem);

export const deepAnalysisResultSchema = z.strictObject({
  architecture_summary: z.string().min(1).max(DEEP_ANALYSIS_LIMITS.summaryChars),
  important_modules: z.array(z.strictObject({
    name: nameText,
    purpose: itemText,
    evidence_files: storedEvidence.min(1),
  })).max(DEEP_ANALYSIS_LIMITS.modules),
  technical_decisions: z.array(z.strictObject({
    decision: itemText,
    rationale: itemText,
    evidence_files: storedEvidence,
  })).max(DEEP_ANALYSIS_LIMITS.decisions),
  security_sensitive_areas: z.array(z.strictObject({
    area: nameText,
    reason: itemText,
    evidence_files: storedEvidence.min(1),
  })).max(DEEP_ANALYSIS_LIMITS.securityAreas),
  concepts: z.array(z.strictObject({
    term: nameText,
    /** Unicode-normalized, whitespace-collapsed, lowercased term; unique within a commit. */
    normalized_term: nameText,
    explanation: itemText,
  })).max(DEEP_ANALYSIS_LIMITS.concepts),
});

export type DeepAnalysisOutput = z.infer<typeof deepAnalysisOutputSchema>;
export type DeepAnalysisResult = z.infer<typeof deepAnalysisResultSchema>;
