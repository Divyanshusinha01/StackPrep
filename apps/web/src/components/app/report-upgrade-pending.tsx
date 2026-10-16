"use client";

import { Loader2 } from "lucide-react";
import { Notice } from "@/components/app/notice";
import { usePollWhile } from "@/components/app/use-poll-while";

/** Shown above a legacy report while it is regenerated; re-renders the page until the job settles. */
export function ReportUpgradePending() {
  usePollWhile(true);
  return (
    <Notice tone="info" icon={false} className="mt-0 mb-8 print:hidden">
      <Loader2 className="size-4 shrink-0 motion-safe:animate-spin text-brand" aria-hidden />
      <span className="min-w-0 flex-1">
        Regenerating this report with answer reviews and learning resources. This page updates when it is ready.
      </span>
    </Notice>
  );
}
