import type { Metadata } from "next";
import Link from "next/link";
import { SearchX } from "lucide-react";
import { EmptyState } from "@/components/app/empty-state";
import { FooterLinks } from "@/components/landing/site-footer";
import { Wordmark } from "@/components/landing/wordmark";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Not found",
  robots: { index: false },
};

const SIGN_IN_HINT = <span className="sr-only"> (sign-in required)</span>;

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
        size="page"
        icon={<SearchX />}
        title="This page could not be found"
        description="It may have been deleted, or the link is wrong."
        action={
          <>
            <Button asChild>
              <Link href="/">Home</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/workspaces">
                Go to workspaces
                {SIGN_IN_HINT}
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/interviews">
                Your interviews
                {SIGN_IN_HINT}
              </Link>
            </Button>
          </>
        }
      />
      <FooterLinks className="relative [&_ul]:justify-center" />
    </main>
  );
}
