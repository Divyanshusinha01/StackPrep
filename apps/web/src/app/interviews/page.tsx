import type { Metadata } from "next";
import { AppShell } from "@/components/app/app-shell";
import { requireUser } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Interviews · StackPrep",
  robots: { index: false },
};

export default async function InterviewsPage() {
  const user = await requireUser("/interviews");

  return (
    <AppShell user={user}>
      <h1 className="font-display text-2xl font-semibold tracking-tight">Interviews</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Your interviews and reports will appear here.
      </p>
    </AppShell>
  );
}
