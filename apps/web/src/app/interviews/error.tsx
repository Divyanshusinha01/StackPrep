"use client";

import { RouteError } from "@/components/app/route-error";

export default function InterviewsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteError error={error} reset={reset} backHref="/interviews" backLabel="Back to interviews" />;
}
