"use client";

import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A native disclosure for one report item. Opens itself when its anchor is the URL hash and before
 * printing, so linked and printed reports never hide content.
 */
export function ReviewDisclosure({
  id,
  defaultOpen,
  summary,
  className,
  children,
}: {
  id: string;
  defaultOpen: boolean;
  summary: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  useEffect(() => {
    const openForHash = () => {
      if (window.location.hash === `#${id}`) {
        setOpen(true);
      }
    };
    const openForPrint = () => setOpen(true);
    openForHash();
    window.addEventListener("hashchange", openForHash);
    window.addEventListener("beforeprint", openForPrint);
    return () => {
      window.removeEventListener("hashchange", openForHash);
      window.removeEventListener("beforeprint", openForPrint);
    };
  }, [id]);

  return (
    <details
      id={id}
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
      className={cn(
        "group scroll-mt-[calc(var(--app-header-h)+1.5rem)] surface-inset rounded-xl border bg-panel/60 print:break-inside-avoid-page",
        className,
      )}
    >
      <summary className="flex cursor-pointer list-none items-start gap-3 rounded-xl p-4 select-none focus-ring hover:bg-panel-raised/40 sm:p-5 [&::-webkit-details-marker]:hidden">
        <div className="min-w-0 flex-1">{summary}</div>
        <ChevronDown
          className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180 print:hidden"
          aria-hidden
        />
      </summary>
      <div className="border-t px-4 pt-4 pb-5 sm:px-5">{children}</div>
    </details>
  );
}
