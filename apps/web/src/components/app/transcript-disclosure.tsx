"use client";

import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";

/**
 * Collapsible wrapper for the full transcript. Opens itself when the page is reached through
 * `#transcript` and before printing, so neither path lands on a closed section.
 */
export function TranscriptDisclosure({
  defaultOpen,
  count,
  children,
}: {
  defaultOpen: boolean;
  count: number;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  useEffect(() => {
    const openForHash = () => {
      if (window.location.hash === "#transcript") {
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
  }, []);

  return (
    <details
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
      className="group mt-4 rounded-xl border bg-panel/40 print:border-0 print:bg-transparent"
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-4 py-3 text-sm select-none focus-ring hover:bg-panel-raised/50 print:hidden [&::-webkit-details-marker]:hidden">
        <span className="text-muted-foreground">
          {open ? "Hide transcript" : "Show transcript"}
          <span className="ml-2 text-xs">
            ({count} {count === 1 ? "turn" : "turns"})
          </span>
        </span>
        <ChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden />
      </summary>
      <div className="border-t px-4 pb-4 print:border-0 print:px-0">{children}</div>
    </details>
  );
}
