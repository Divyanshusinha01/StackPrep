import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { StatusChip } from "@/components/app/status-chip";
import { getHealth } from "@/lib/api";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Status",
  robots: { index: false },
};

export default async function StatusPage() {
  const result = await getHealth().then(
    (health) => ({ ok: true as const, health }),
    (error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) }),
  );

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-4 px-6">
      <Link
        href="/"
        className="focus-ring inline-flex w-fit items-center gap-1.5 rounded-sm text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden />
        Home
      </Link>
      <h1 className="font-display text-2xl font-semibold tracking-tight">API status</h1>
      {result.ok ? (
        <p data-testid="api-status" className="flex flex-wrap items-center gap-2 text-sm">
          <StatusChip tone="success">{result.health.status}</StatusChip>
          <span className="text-muted-foreground">checked {result.health.timestamp}</span>
        </p>
      ) : (
        <p data-testid="api-status" className="flex flex-wrap items-center gap-2 text-sm">
          <StatusChip tone="danger">unreachable</StatusChip>
          <span className="text-danger-foreground">{result.error}</span>
        </p>
      )}
    </main>
  );
}
