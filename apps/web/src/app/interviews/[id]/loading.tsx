import { AppShell } from "@/components/app/app-shell";
import { Skeleton } from "@/components/app/skeleton";

export default function Loading() {
  return (
    <AppShell user={null}>
      <div role="status" aria-live="polite">
        <span className="sr-only">Loading interview…</span>
        <Skeleton className="h-4 w-40" />
        <Skeleton className="mt-4 h-8 w-48" />
        <Skeleton className="mt-3 h-4 w-80 max-w-full" />
        <div className="mt-8 grid gap-6 md:grid-cols-[minmax(0,1fr)_20rem]">
          <Skeleton className="aspect-video w-full rounded-xl" />
          <div className="space-y-4">
            <Skeleton className="h-28 rounded-xl" />
            <Skeleton className="h-10 rounded-lg" />
          </div>
        </div>
      </div>
    </AppShell>
  );
}
