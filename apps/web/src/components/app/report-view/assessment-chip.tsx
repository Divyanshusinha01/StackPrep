import type { AnswerAssessment } from "@stackprep/shared";
import { type ChipTone, StatusChip } from "@/components/app/status-chip";

export const ASSESSMENT_LABELS: Record<AnswerAssessment, string> = {
  correct: "Correct",
  partially_correct: "Partially correct",
  incorrect: "Incorrect",
  unanswered: "Unanswered",
};

const ASSESSMENT_TONES: Record<AnswerAssessment, ChipTone> = {
  correct: "success",
  partially_correct: "warning",
  incorrect: "danger",
  unanswered: "neutral",
};

/** The evaluator's verdict on one answer; the label carries the meaning, the tone only reinforces it. */
export function AssessmentChip({ assessment }: { assessment: AnswerAssessment }) {
  return (
    <StatusChip tone={ASSESSMENT_TONES[assessment]} data-assessment={assessment}>
      {ASSESSMENT_LABELS[assessment]}
    </StatusChip>
  );
}
