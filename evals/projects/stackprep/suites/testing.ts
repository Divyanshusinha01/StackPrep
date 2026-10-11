/** Fakes for the text-surface suite tests: a scripted model for every pipeline stage and the judge. */
import type { AnswerEvaluation } from "../../../../supabase/functions/interviews/tools/evaluate-answer.ts";
import type { InterviewReport } from "@stackprep/shared";
import type { StructuredRequest } from "../../../../supabase/functions/_shared/ai/provider.ts";
import { createFakeAIProvider, type FakeAIProvider } from "../../../../supabase/functions/_shared/testing.ts";
import type { Recorder, RunEnv } from "../../../core/types.ts";
import { CONFIG } from "../project.ts";
import { loadClaims } from "../src/claims.ts";
import type { IndexedCorpus } from "../src/corpus.ts";
import { JUDGE_SCHEMA_NAME, type JudgeVerdict } from "../src/judge.ts";
import { loadSessions } from "../src/sessions.ts";
import type { ContradictionContext } from "./contradiction.ts";
import type { SupportContext } from "./support.ts";

export const projectDir = new URL("../", import.meta.url);

export const passThrough: Recorder = { call: (_req, produce) => produce() };

export function runEnv(recorder: Recorder, mode: RunEnv["mode"] = "live"): RunEnv {
  return { mode, recorder, seed: 1, samples: 1, log: () => {} };
}

export function suiteContext(corpus: IndexedCorpus, live?: FakeAIProvider): SupportContext & ContradictionContext {
  return {
    projectDir,
    corpora: new Map([[corpus.id, corpus]]),
    pipeline: CONFIG.pipeline,
    support: CONFIG.support,
    contradiction: CONFIG.contradiction,
    liveAI: live,
    pipelineRuns: new Map(),
  };
}

/** A claim citing a real span with behaviour the code does not have. */
export const WRONG_CLAIM = "createOrder in src/orders/service.ts:21-31 deduplicates retried requests with an idempotency key.";
const RIGHT_CLAIM = "createOrder in src/orders/service.ts:21-31 writes the order and its items in one transaction.";

export interface PipelineScript {
  /** Put WRONG_CLAIM in every evaluation's gaps instead of a correct claim. */
  wrongClaim?: boolean;
  /** Report with an invented repository_evidence path (removed by groundReport) and an invented path in a weakness (kept). */
  inventedPaths?: boolean;
}

function evaluation(script: PipelineScript): AnswerEvaluation {
  return {
    area_id: "security",
    score: 3,
    rating: "developing",
    strengths: ["chargeCard in src/payments/charge.ts:29-31 retries the gateway call five times."],
    gaps: [script.wrongClaim ? WRONG_CLAIM : RIGHT_CLAIM],
    repo_evidence: ["src/auth/password.ts", "Postgres"],
    discrepancy: false,
    discrepancy_detail: "",
    area_status: "partial",
    guidance: "follow_up",
    focus: "Ask how the salt is chosen.",
  };
}

function report(script: PipelineScript): InterviewReport {
  return {
    executive_summary: "The candidate traced the order flow well and was unsure about password storage.",
    categories: [{ name: "Security", rating: "developing", narrative: "The candidate traced OrderService.createOrder from validation to the charge." }],
    strengths: [],
    gaps: [],
    interview_evidence: [],
    repository_evidence: [
      { path: "src/auth/password.ts", note: "hashPassword uses SHA-256 with a static salt." },
      ...(script.inventedPaths ? [{ path: "src/auth/tokens.ts", note: "Tokens are signed with HMAC." }] : []),
    ],
    areas_to_improve: [],
    struggled_questions: [{
      question: "How are passwords stored?",
      performance: "Said bcrypt.",
      weakness: script.inventedPaths ? "Missed that src/payments/refund.ts retries refunds." : "Missed that hashPassword uses a static salt.",
      repository_area: "src/auth/",
      learning_direction: "Read about slow password hashing.",
    }],
  };
}

/** The claim inside a judge request. */
export function judgedClaim(request: StructuredRequest<unknown>): string {
  return request.input.match(/<claim>\n([\s\S]*?)\n<\/claim>/)![1];
}

export type JudgeRule = (claim: string, calibrated: boolean | undefined) => JudgeVerdict["verdict"];

/** Agrees with the calibration labels; on pipeline claims, flags only WRONG_CLAIM. */
export const accurateJudge: JudgeRule = (claim, calibrated) =>
  calibrated !== undefined ? (calibrated ? "supported" : "unsupported") : claim === WRONG_CLAIM ? "unsupported" : "supported";

/** A scripted model for plan, evaluations, reports and the judge on one corpus. */
export async function scriptedModel(corpus: IndexedCorpus, script: PipelineScript = {}, judge: JudgeRule = accurateJudge): Promise<FakeAIProvider> {
  const sessions = await loadSessions(projectDir, corpus);
  const claims = await loadClaims(projectDir, corpus);
  const labels = new Map(claims.calibration.map((p) => [p.claim.trim(), p.supported]));
  return createFakeAIProvider((request) => {
    switch (request.schemaName) {
      case "interview_plan":
        return structuredClone(sessions.state);
      case "answer_evaluation":
        return evaluation(script);
      case "interview_report":
        return report(script);
      case JUDGE_SCHEMA_NAME: {
        const claim = judgedClaim(request);
        return { verdict: judge(claim, labels.get(claim)), reason: "scripted" };
      }
      default:
        return new Error(`unexpected request ${request.schemaName}`);
    }
  });
}
