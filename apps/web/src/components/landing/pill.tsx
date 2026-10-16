import { cn } from "@/lib/utils";

/** Rounded mono chip used for the hero badge, onboarding steps and trust points. */
export const PILL_CLASS =
  "inline-flex items-center gap-1.5 rounded-full border border-border-strong/80 bg-panel/80 px-3 py-1 font-mono text-xs text-muted-foreground";

export function Pill({ className, ...props }: React.ComponentProps<"span">) {
  return <span className={cn(PILL_CLASS, className)} {...props} />;
}
