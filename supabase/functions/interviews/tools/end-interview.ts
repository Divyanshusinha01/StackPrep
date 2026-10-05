import { type CoverageMap, type EndInterviewInput, type EndInterviewOutput, VOICE_WRAP_UP_SECONDS } from "@stackprep/shared";
import { parseState } from "./coverage.ts";
import type { ToolContext, ToolOutcome } from "./types.ts";

export const MIN_EVALUATIONS = 4;

export const CLOSING_GUIDANCE =
  "Give a brief closing statement now: thank the candidate, say the interview is complete and that their report will follow.";
export const CONTINUE_GUIDANCE = "Not yet. Continue with the next planned topic and gather more evidence.";

/** Every high-priority area at least partly explored, with enough evaluated answers. */
export function hasSufficientEvidence(coverage: CoverageMap | null, evaluations: number): boolean {
  if (!coverage || evaluations < MIN_EVALUATIONS) {
    return false;
  }
  return coverage.areas.filter((a) => a.priority === "high").every((a) => a.status !== "not_started");
}

export async function endInterview(ctx: ToolContext, input: EndInterviewInput): Promise<ToolOutcome> {
  const { interview, store } = ctx;
  const [snapshot, evaluated] = await Promise.all([
    store.getInterviewState(interview.id),
    store.listEvaluationCategories(interview.id),
  ]);
  const sufficient = hasSufficientEvidence(parseState(snapshot)?.coverage ?? null, evaluated.length);
  const timeTarget = ctx.elapsedSeconds >= VOICE_WRAP_UP_SECONDS;
  const accepted = sufficient || timeTarget;

  // false means a concurrent call already completed it (and queued the report); the outcome is the same.
  if (accepted && await store.completeInterview(interview.id, ctx.userId, null)) {
    await ctx.requestReport();
  }
  const output: EndInterviewOutput = {
    ok: true,
    accepted,
    guidance: accepted ? CLOSING_GUIDANCE : CONTINUE_GUIDANCE,
  };
  return {
    output,
    // Owners can read interview_events, so the summary never says why (that would expose coverage).
    summary: { ok: true, accepted, requested_reason: input.reason },
    persist: true,
  };
}
