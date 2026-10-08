import type { Metadata } from "next";
import Link from "next/link";
import { SearchX } from "lucide-react";
import { EmptyState } from "@/components/app/empty-state";
import { Wordmark } from "@/components/landing/wordmark";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Not found · StackPrep",
  robots: { index: false },
};

export default function NotFound() {
  return (
    <main className="relative flex min-h-dvh flex-col items-center justify-center gap-8 overflow-hidden px-4 py-12">
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-grid mask-radial opacity-70" />
      <Link href="/" aria-label="StackPrep home" className="focus-ring relative rounded-md">
        <Wordmark />
      </Link>
      <EmptyState
        className="relative w-full max-w-md bg-panel/80"
        headingLevel={1}
        icon={<SearchX />}
        title="This page could not be found"
        description="It may have been deleted, or the link is wrong."
        action={
          <>
            <Button asChild>
              <Link href="/workspaces">Go to workspaces</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/interviews">Your interviews</Link>
            </Button>
          </>
        }
      />
    </main>
  );
}
