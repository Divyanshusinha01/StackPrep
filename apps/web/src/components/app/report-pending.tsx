"use client";

import { Loader2 } from "lucide-react";
import { usePollWhile } from "@/components/app/use-poll-while";

/** Shown while the report job runs; re-renders the page until the persisted job state changes. */
export function ReportPending() {
  usePollWhile(true);
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-3 rounded-lg border bg-panel-raised/70 px-4 py-3 text-sm"
    >
      <Loader2 className="size-4 shrink-0 motion-safe:animate-spin text-brand" aria-hidden />
      Generating your report. Finding learning resources can take a minute or two.
    </div>
  );
}
