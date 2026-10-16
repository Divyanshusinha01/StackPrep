import { cn } from "@/lib/utils";

/** Centered placeholder for a list with nothing in it yet, with an optional next step. */
export function EmptyState({
  icon,
  title,
  description,
  action,
  headingLevel = 2,
  size = "section",
  className,
}: {
  icon: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  /** Use 1 when it is the whole page, 3 when it sits inside a section that already has an h2. */
  headingLevel?: 1 | 2 | 3;
  /** `page` gives the heading page-title weight for full-page states such as 404. */
  size?: "section" | "page";
  className?: string;
}) {
  const Heading = (["h1", "h2", "h3"] as const)[headingLevel - 1];
  return (
    <div
      className={cn(
        "surface-inset flex flex-col items-center rounded-xl border border-border/80 bg-panel/40 px-6 py-12 text-center",
        className,
      )}
    >
      <div
        aria-hidden
        className="grid size-11 place-items-center rounded-xl border border-brand/25 bg-brand-muted/70 text-brand [&_svg]:size-5"
      >
        {icon}
      </div>
      <Heading
        className={cn(
          "mt-4 font-display font-semibold tracking-tight",
          size === "page" ? "text-2xl text-balance" : "text-base",
        )}
      >
        {title}
      </Heading>
      {description ? <p className="mt-1.5 max-w-md text-sm leading-relaxed text-muted-foreground">{description}</p> : null}
      {action ? <div className="mt-6 flex flex-wrap justify-center gap-3">{action}</div> : null}
    </div>
  );
}
