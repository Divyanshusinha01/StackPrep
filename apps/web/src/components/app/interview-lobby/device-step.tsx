import { Check, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";

export type StepState = "pending" | "active" | "done" | "failed";

/** Numbered circle for one lobby step; turns into a check, spinner or cross as the step progresses. */
export function StepMarker({ step, state }: { step: number; state: StepState }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-7 shrink-0 place-items-center rounded-full border text-xs font-semibold tabular-nums transition-colors",
        state === "done" && "border-success/40 bg-success/15 text-success",
        state === "active" && "border-brand/50 bg-brand-muted text-brand",
        state === "failed" && "border-danger/40 bg-danger/15 text-danger",
        state === "pending" && "border-border text-muted-foreground",
      )}
    >
      {state === "done" ? (
        <Check className="size-3.5" />
      ) : state === "active" ? (
        <Loader2 className="size-3.5 motion-safe:animate-spin" />
      ) : state === "failed" ? (
        <X className="size-3.5" />
      ) : (
        step
      )}
    </span>
  );
}

/** One device in the check list: marker, label, optional hint while waiting, and extra content. */
export function DeviceStep({
  step,
  ok,
  waiting,
  icon,
  label,
  hint,
  children,
}: {
  step: number;
  ok: boolean;
  /** The check is running but has not passed yet. */
  waiting: boolean;
  icon: React.ReactNode;
  label: string;
  hint?: string;
  children?: React.ReactNode;
}) {
  return (
    <li className="flex gap-3 py-3.5">
      <StepMarker step={step} state={ok ? "done" : waiting ? "active" : "pending"} />
      <div className="min-w-0 flex-1 pt-0.5">
        <p className={cn("flex items-center gap-2 text-sm font-medium", ok ? "text-foreground" : "text-muted-foreground")}>
          {icon}
          <span>{label}</span>
          {!ok && hint ? <span className="text-xs font-normal">{hint}</span> : null}
          <span className="sr-only">{ok ? "(passed)" : "(not yet passed)"}</span>
        </p>
        {children}
      </div>
    </li>
  );
}
