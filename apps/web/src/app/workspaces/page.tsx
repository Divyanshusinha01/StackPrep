import type { Metadata } from "next";
import { AppShell } from "@/components/app/app-shell";
import { requireUser } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Workspaces · StackPrep",
  robots: { index: false },
};

export default async function WorkspacesPage() {
  const user = await requireUser("/workspaces");

  return (
    <AppShell user={user}>
      <h1 className="font-display text-2xl font-semibold tracking-tight">Workspaces</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Repository workspaces will appear here once repository connection is available.
      </p>
    </AppShell>
  );
}
