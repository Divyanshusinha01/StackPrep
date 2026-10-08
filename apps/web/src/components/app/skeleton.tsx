import { cn } from "@/lib/utils";

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn("rounded-md bg-muted/60 motion-safe:animate-pulse", className)} />;
}

/** Loading placeholder for an app page: header, then a list of rows. */
export function PageSkeleton({ label, rows = 4, meta = false }: { label: string; rows?: number; meta?: boolean }) {
  return (
    <div role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      <div className="mb-8">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="mt-3 h-4 w-80 max-w-full" />
        {meta ? <Skeleton className="mt-3 h-4 w-48" /> : null}
      </div>
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
    </div>
  );
}
