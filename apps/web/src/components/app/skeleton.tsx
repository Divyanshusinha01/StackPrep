import { cn } from "@/lib/utils";

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn("rounded-md bg-muted/60 motion-safe:animate-pulse", className)} />;
}

function ListRows({ rows }: { rows: number }) {
  return (
    <div className="divide-y rounded-xl border bg-panel/40">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-4">
          <Skeleton className="size-8 rounded-full" />
          <div className="flex-1">
            <Skeleton className="h-4 w-48 max-w-full" />
            <Skeleton className="mt-2 h-3 w-32" />
          </div>
          <Skeleton className="h-6 w-16 rounded-full" />
        </div>
      ))}
    </div>
  );
}

/** Start-interview card with the three analysis steps, then the history list. */
function WorkspaceBody({ rows }: { rows: number }) {
  return (
    <>
      <div className="rounded-xl border bg-panel/40 p-6">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex-1">
            <Skeleton className="h-6 w-60 max-w-full" />
            <Skeleton className="mt-3 h-4 w-full max-w-xl" />
            <Skeleton className="mt-2 h-4 w-3/4 max-w-md" />
          </div>
          <Skeleton className="h-10 w-full rounded-md sm:w-40" />
        </div>
        <div className="mt-6 grid gap-3 border-t border-border/80 pt-5 sm:grid-cols-3">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-11 rounded-lg" />
          ))}
        </div>
      </div>
      <Skeleton className="mt-10 mb-4 h-6 w-44" />
      <ListRows rows={rows} />
    </>
  );
}

/** A single settings section: heading, copy, status box, and an input row. */
function FormBody() {
  return (
    <div className="max-w-3xl rounded-xl border bg-panel/40 p-6">
      <Skeleton className="h-6 w-44" />
      <Skeleton className="mt-3 h-4 w-full" />
      <Skeleton className="mt-2 h-4 w-5/6" />
      <Skeleton className="mt-6 h-16 w-full rounded-lg" />
      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-end">
        <Skeleton className="h-10 flex-1" />
        <Skeleton className="h-10 w-full sm:w-40" />
      </div>
    </div>
  );
}

/** Loading placeholder for an app page: the header, then a body shaped like the page. */
export function PageSkeleton({
  label,
  rows = 4,
  meta = false,
  variant = "list",
}: {
  label: string;
  rows?: number;
  meta?: boolean;
  variant?: "list" | "workspace" | "form";
}) {
  return (
    <div role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      <div className="mb-8 border-b border-border/70 pb-6">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="mt-3 h-4 w-80 max-w-full" />
        {meta ? <Skeleton className="mt-3 h-4 w-48" /> : null}
      </div>
      {variant === "workspace" ? <WorkspaceBody rows={rows} /> : variant === "form" ? <FormBody /> : <ListRows rows={rows} />}
    </div>
  );
}
