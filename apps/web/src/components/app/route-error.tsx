"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";
import Link from "next/link";
import { TriangleAlert } from "lucide-react";
import { AppShell } from "@/components/app/app-shell";
import { EmptyState } from "@/components/app/empty-state";
import { Button } from "@/components/ui/button";

/** Error boundary body for the app routes: keeps the shell and offers a retry. */
export function RouteError({
  error,
  reset,
  backHref,
  backLabel,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  backHref: string;
  backLabel: string;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <AppShell user={null}>
      <EmptyState
        headingLevel={1}
        icon={<TriangleAlert />}
        title="Something went wrong"
        description="This page could not be loaded. Try again, or go back and retry in a moment."
        action={
          <>
            <Button onClick={reset}>Try again</Button>
            <Button asChild variant="outline">
              <Link href={backHref}>{backLabel}</Link>
            </Button>
          </>
        }
      />
    </AppShell>
  );
}
