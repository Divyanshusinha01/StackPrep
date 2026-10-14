import { cn } from "@/lib/utils";
import { Spotlight } from "../spotlight";

export type PanelProps = {
  /** Screen-reader description; the mockup's sample content is presentational, not real data. */
  label: string;
  title: React.ReactNode;
  meta?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  /** Marks the focal mockup of a section with a brand halo. */
  glow?: boolean;
};

/** Window chrome shared by every product mockup on the landing page. */
export function Panel({ label, title, meta, children, className, bodyClassName, glow }: PanelProps) {
  return (
    <Spotlight
      role="img"
      aria-label={label}
      className={cn(
        "overflow-hidden rounded-xl border border-white/5 bg-panel text-left shadow-[inset_0_1px_0_0_oklch(1_0_0/0.06),0_24px_64px_-24px_rgb(0_0_0/0.7)]",
        glow &&
          "border-brand/25 shadow-[inset_0_1px_0_0_oklch(1_0_0/0.08),0_0_0_1px_var(--brand-muted),0_30px_90px_-30px_var(--brand-glow),0_24px_64px_-24px_rgb(0_0_0/0.7)]",
        className,
      )}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-6 top-0 h-px bg-linear-to-r from-transparent via-white/25 to-transparent"
      />
      <div className="flex h-10 items-center gap-3 border-b bg-panel-raised/60 px-4 font-mono text-xs text-muted-foreground">
        <span className="flex gap-1.5" aria-hidden>
          <span className="size-2 rounded-full bg-foreground/15" />
          <span className="size-2 rounded-full bg-foreground/15" />
          <span className="size-2 rounded-full bg-foreground/15" />
        </span>
        <span className="truncate text-foreground/80">{title}</span>
        {meta ? <span className="ml-auto flex shrink-0 items-center gap-1.5">{meta}</span> : null}
      </div>
      <div className={cn("p-4", bodyClassName)}>{children}</div>
    </Spotlight>
  );
}

export function FileChip({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border border-brand/25 bg-brand-muted px-2 py-0.5 font-mono text-[11px] text-brand",
        className,
      )}
    >
      {children}
    </span>
  );
}
