import { cn } from "@/lib/utils";

export type ChipTone = "neutral" | "info" | "success" | "warning" | "danger" | "brand";

const TONES: Record<ChipTone, { chip: string; dot: string }> = {
  neutral: { chip: "border-border-strong/70 bg-panel-raised/70 text-muted-foreground", dot: "bg-muted-foreground/80" },
  info: { chip: "border-info/30 bg-info/10 text-info", dot: "bg-info" },
  success: { chip: "border-success/30 bg-success/10 text-success", dot: "bg-success" },
  warning: { chip: "border-warning/30 bg-warning/10 text-warning", dot: "bg-warning" },
  danger: { chip: "border-danger/30 bg-danger/10 text-danger", dot: "bg-danger" },
  brand: { chip: "border-brand/35 bg-brand-muted text-brand", dot: "bg-brand" },
};

/** Small pill used for every status and rating label in the app. */
export function StatusChip({
  tone,
  pulse = false,
  className,
  children,
  ...props
}: Omit<React.ComponentProps<"span">, "children"> & {
  tone: ChipTone;
  /** Animates the dot, for states that are still changing. */
  pulse?: boolean;
  children: React.ReactNode;
}) {
  return (
    <span
      {...props}
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
