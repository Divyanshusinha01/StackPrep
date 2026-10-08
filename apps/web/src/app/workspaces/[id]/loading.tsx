import { AppShell } from "@/components/app/app-shell";
import { PageSkeleton } from "@/components/app/skeleton";

export default function Loading() {
  return (
    <AppShell user={null}>
      <PageSkeleton label="Loading workspace…" rows={3} meta />
    </AppShell>
  );
}
