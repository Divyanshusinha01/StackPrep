import { cn } from "@/lib/utils";

export type ChipTone = "neutral" | "info" | "success" | "warning" | "danger" | "brand";

const TONES: Record<ChipTone, { chip: string; dot: string }> = {
  neutral: { chip: "border-border-strong/70 bg-panel-raised/70 text-muted-foreground", dot: "bg-muted-foreground/80" },
  info: { chip: "border-sky-500/30 bg-sky-500/10 text-sky-300", dot: "bg-sky-300" },
  success: { chip: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300", dot: "bg-emerald-300" },
  warning: { chip: "border-amber-500/30 bg-amber-500/10 text-amber-300", dot: "bg-amber-300" },
  danger: { chip: "border-red-500/30 bg-red-500/10 text-red-300", dot: "bg-red-300" },
  brand: { chip: "border-brand/35 bg-brand-muted text-brand", dot: "bg-brand" },
};

/** Small pill used for every status and rating label in the app. */
export function StatusChip({
  tone,
  pulse = false,
  className,
  children,
}: {
  tone: ChipTone;
  /** Animates the dot, for states that are still changing. */
  pulse?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium tracking-wide",
        TONES[tone].chip,
        "print:border-border print:bg-transparent print:text-foreground",
        className,
      )}
    >
      <span aria-hidden className={cn("size-1.5 rounded-full", TONES[tone].dot, pulse && "motion-safe:animate-pulse")} />
      {children}
    </span>
  );
}
