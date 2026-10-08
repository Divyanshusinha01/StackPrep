import type { InterviewStatus } from "@stackprep/shared";
import { type ChipTone, StatusChip } from "@/components/app/status-chip";

const LABELS: Record<InterviewStatus, string> = {
  created: "Not started",
  in_progress: "In progress",
  paused: "Paused",
  completed: "Completed",
  terminated: "Ended",
  failed: "Failed",
};

const TONES: Record<InterviewStatus, ChipTone> = {
  created: "neutral",
  in_progress: "info",
  paused: "warning",
  completed: "success",
  terminated: "danger",
  failed: "danger",
};

function label(status: InterviewStatus, terminationReason: string | null | undefined): string {
  if (status === "completed" && terminationReason === "user_ended") {
    return "Ended by you";
  }
  if (status === "terminated" && terminationReason === "user_abandoned") {
    return "Ended, no report";
  }
  return LABELS[status];
}

export function InterviewStatusBadge({
  status,
  terminationReason,
}: {
  status: InterviewStatus;
  terminationReason?: string | null;
}) {
  const tone = status === "terminated" && terminationReason === "user_abandoned" ? "neutral" : TONES[status];
  return (
    <StatusChip tone={tone} pulse={status === "in_progress"}>
      {label(status, terminationReason)}
    </StatusChip>
  );
}
