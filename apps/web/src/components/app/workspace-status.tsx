import type { WorkspaceStatus } from "@stackprep/shared";
import { type ChipTone, StatusChip } from "@/components/app/status-chip";

const LABELS: Record<WorkspaceStatus, string> = {
  analyzing: "Analyzing",
  ready: "Ready",
  failed: "Analysis failed",
};

const TONES: Record<WorkspaceStatus, ChipTone> = {
  analyzing: "neutral",
  ready: "success",
  failed: "danger",
};

export function WorkspaceStatusBadge({ status }: { status: WorkspaceStatus }) {
  return (
    <StatusChip tone={TONES[status]} pulse={status === "analyzing"}>
      {LABELS[status]}
    </StatusChip>
  );
}
