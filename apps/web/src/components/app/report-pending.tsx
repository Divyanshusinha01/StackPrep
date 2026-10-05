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
      className="mt-6 flex items-center gap-2 rounded-md border border-border bg-panel/60 px-4 py-3 text-sm"
    >
      <Loader2 className="size-4 animate-spin" aria-hidden />
      Generating your report. This usually takes under a minute.
    </div>
  );
}
