"use client";

import { RouteError } from "@/components/app/route-error";

export default function SettingsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteError error={error} reset={reset} backHref="/workspaces" backLabel="Back to workspaces" />;
}
