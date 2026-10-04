import type { WorkspaceStatus } from "@stackprep/shared";
import { cn } from "@/lib/utils";

const LABELS: Record<WorkspaceStatus, string> = {
  analyzing: "Analyzing",
  ready: "Ready",
  failed: "Analysis failed",
};

export function WorkspaceStatusBadge({ status }: { status: WorkspaceStatus }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs",
        status === "analyzing" && "border-border text-muted-foreground",
        status === "ready" && "border-emerald-500/30 text-emerald-300",
        status === "failed" && "border-red-500/30 text-red-300",
      )}
    >
      {LABELS[status]}
    </span>
  );
}
