import type { InterviewStatus } from "@stackprep/shared";
import { cn } from "@/lib/utils";

const LABELS: Record<InterviewStatus, string> = {
  created: "Not started",
  in_progress: "In progress",
  paused: "Paused",
  completed: "Completed",
  terminated: "Ended",
  failed: "Failed",
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
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs",
        (status === "created" || status === "paused") && "border-border text-muted-foreground",
        status === "in_progress" && "border-sky-500/30 text-sky-300",
        status === "completed" && "border-emerald-500/30 text-emerald-300",
        (status === "terminated" || status === "failed") && "border-red-500/30 text-red-300",
      )}
    >
      {label(status, terminationReason)}
    </span>
  );
}
