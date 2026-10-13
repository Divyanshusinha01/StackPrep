import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Title row shared by the app pages: optional back link, the page's only h1, a status badge next
 * to it, a description or meta line below, and actions aligned right on wide screens.
 */
export function PageHeader({
  title,
  titleClassName,
  badge,
  description,
  actions,
  back,
  children,
}: {
  title: React.ReactNode;
  titleClassName?: string;
  badge?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  back?: { href: string; label: React.ReactNode };
  /** Extra content under the description, such as repository meta. */
  children?: React.ReactNode;
}) {
  return (
    <header className="mb-8 border-b border-border/70 pb-6 print:border-border print:pb-4">
      {back ? (
        <Link
          href={back.href}
          className="group mb-3 inline-flex max-w-full items-center gap-1.5 rounded-md text-xs font-medium tracking-wide text-muted-foreground transition-colors focus-ring hover:text-foreground print:hidden"
        >
          <ArrowLeft
            className="size-3.5 shrink-0 transition-transform duration-150 group-hover:-translate-x-0.5"
            aria-hidden
          />
          <span className="truncate">{back.label}</span>
        </Link>
      ) : null}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1
              className={cn(
                "min-w-0 break-words font-display text-2xl font-semibold tracking-tight sm:text-[1.75rem]",
                titleClassName,
              )}
            >
              {title}
            </h1>
            {badge}
          </div>
          {description ? (
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">{description}</p>
          ) : null}
          {children}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2 print:hidden">{actions}</div> : null}
      </div>
    </header>
  );
}
