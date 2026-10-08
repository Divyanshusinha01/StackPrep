import { AppShell } from "@/components/app/app-shell";
import { Skeleton } from "@/components/app/skeleton";

export default function Loading() {
  return (
    <AppShell user={null}>
      <div role="status" aria-live="polite">
        <span className="sr-only">Loading report…</span>
        <Skeleton className="h-4 w-40" />
        <Skeleton className="mt-4 h-8 w-64" />
        <div className="mt-10 grid gap-10 lg:grid-cols-[12rem_minmax(0,1fr)]">
          <div className="hidden space-y-2.5 lg:block">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="h-3.5 w-36" />
            ))}
          </div>
          <div className="space-y-3">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-11/12" />
            <Skeleton className="h-4 w-4/5" />
            <div className="grid gap-3 pt-6 sm:grid-cols-2">
              {Array.from({ length: 4 }, (_, i) => (
                <Skeleton key={i} className="h-28 rounded-xl" />
              ))}
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
