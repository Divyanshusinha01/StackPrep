import type { Metadata } from "next";
import { getHealth } from "@/lib/api";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Status — StackPrep",
  robots: { index: false },
};

export default async function StatusPage() {
  const result = await getHealth().then(
    (health) => ({ ok: true as const, health }),
    (error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) }),
  );

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-4 px-6">
      <h1 className="text-2xl font-semibold">API status</h1>
      {result.ok ? (
        <p data-testid="api-status">
          <span className="font-medium text-emerald-400">{result.health.status}</span>
          <span className="text-muted-foreground"> · checked {result.health.timestamp}</span>
        </p>
      ) : (
        <p data-testid="api-status" className="text-red-400">
          unreachable: {result.error}
        </p>
      )}
    </main>
  );
}
