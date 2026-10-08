import type { EndInterviewResponse } from "@stackprep/shared";
import type { PauseControlResult } from "@/lib/interview-events";

export const END_CONFIRM_MESSAGE =
  "Your report will be generated from the answers so far. This can't be undone.";

export const NO_REPORT_MESSAGE =
  "You ended the interview before any answer was evaluated, so there is no report for it.";

const END_ERRORS: Record<string, string> = {
  interview_not_active: "This interview is no longer active.",
};

export function endErrorMessage(code: string): string {
  return END_ERRORS[code] ?? "The interview could not be ended. Try again.";
}

/**
 * Candidate-initiated end: close the voice session, flush buffered turns, then ask the backend to
 * end. The flush comes first so the report job reads every saved answer.
 */
export async function endInterviewInOrder(steps: {
  closeVoice: () => void;
  flushOutbox: () => Promise<void>;
  requestEnd: () => Promise<PauseControlResult<EndInterviewResponse>>;
}): Promise<PauseControlResult<EndInterviewResponse>> {
  steps.closeVoice();
  try {
    await steps.flushOutbox();
  } catch (err) {
    console.warn("Could not flush interview events before ending", err);
  }
  return steps.requestEnd();
}
