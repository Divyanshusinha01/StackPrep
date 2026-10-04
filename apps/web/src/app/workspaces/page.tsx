import type { Metadata } from "next";
import Link from "next/link";
import { AppShell } from "@/components/app/app-shell";
import { Button } from "@/components/ui/button";
import { requireUser } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Workspaces · StackPrep",
  robots: { index: false },
};

export default async function WorkspacesPage() {
  const user = await requireUser("/workspaces");

  return (
    <AppShell user={user}>
      <div className="flex items-center justify-between gap-4">
        <h1 className="font-display text-2xl font-semibold tracking-tight">Workspaces</h1>
        <Button asChild>
          <Link href="/workspaces/new">New workspace</Link>
        </Button>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">
        Connect GitHub and choose a repository to start a workspace.
      </p>
    </AppShell>
  );
}
