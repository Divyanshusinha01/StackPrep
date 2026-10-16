import { Check } from "lucide-react";
import { ONBOARDING_STEP_LABELS, onboardingStepStates } from "@/lib/openai-key-setup";
import { cn } from "@/lib/utils";

/** First-run progress for a new account: sign in, add the OpenAI key, then connect a repository. */
export function SetupChecklist({ keyReady, className }: { keyReady: boolean; className?: string }) {
  const states = onboardingStepStates(keyReady);
  return (
    <ol
      aria-label="Account setup"
      className={cn("flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3", className)}
      data-testid="setup-checklist"
    >
      {ONBOARDING_STEP_LABELS.map((label, i) => {
        const state = states[i];
        return (
          <li
            key={label}
            aria-current={state === "current" ? "step" : undefined}
            data-state={state}
            className={cn(
              "inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs",
              state === "current" && "border-brand/40 bg-brand-muted/70 text-foreground",
              state === "done" && "border-border bg-panel/70 text-muted-foreground",
              state === "upcoming" && "border-dashed border-border bg-transparent text-muted-foreground",
            )}
          >
            <span
              aria-hidden
              className={cn(
                "grid size-4 place-items-center rounded-full font-mono text-[11px]",
                state === "done" ? "bg-success/15 text-success" : state === "current" ? "bg-brand text-primary-foreground" : "border border-border",
              )}
            >
              {state === "done" ? <Check className="size-3" /> : i + 1}
            </span>
            {label}
            <span className="sr-only">{state === "done" ? " (done)" : state === "current" ? " (current step)" : ""}</span>
          </li>
        );
      })}
    </ol>
  );
}
