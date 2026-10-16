"use client";

import { useEffect, useRef } from "react";
import type { TranscriptTurn } from "@/components/app/realtime-transcript";
import { cn } from "@/lib/utils";

export function TranscriptPane({
  title,
  icon,
  turns,
  placeholder,
  side,
  activity,
  latestLabel,
  overlay,
}: {
  title: string;
  icon: React.ReactNode;
  turns: TranscriptTurn[];
  placeholder: string;
  side: "ai" | "user";
  /** Speaking indicator in the pane header. */
  activity: React.ReactNode;
  /** Small label above the latest turn, such as "Current question". */
  latestLabel?: string;
  /** Pinned over the bottom of the log, such as the "Examining …" chip. */
  overlay?: React.ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const id = `pane-${title.toLowerCase()}`;

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [turns]);

  return (
    <section
      aria-labelledby={id}
      className="surface-inset relative flex min-h-0 flex-col overflow-hidden rounded-xl border bg-panel/60"
    >
      <div className="flex items-center justify-between gap-3 border-b bg-panel-raised/40 px-4 py-3">
        <h2 id={id} className="flex items-center gap-2 font-display text-sm font-semibold tracking-tight">
          {icon}
          {title}
        </h2>
        {activity}
      </div>
      <div
        ref={scrollRef}
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
        onScroll={(e) => {
          const el = e.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
        className={cn(
          "flex min-h-0 flex-1 flex-col divide-y divide-border/50 overflow-y-auto overscroll-contain px-4 py-2 text-sm leading-relaxed",
          overlay !== undefined && "pb-14",
        )}
      >
        {turns.length === 0 ? (
          <p className="m-auto max-w-xs py-8 text-center text-sm text-muted-foreground">{placeholder}</p>
        ) : null}
        {turns.map((turn, index) => {
          const isLatest = index === turns.length - 1;
          return (
            <div
              key={turn.itemId}
              className={cn(
                "py-3.5 first:pt-2 last:pb-2",
                isLatest ? "text-foreground" : "text-foreground/80",
              )}
            >
              <div
                className={cn(
                  "border-l-2 pl-3.5 transition-colors",
                  side === "ai"
                    ? isLatest
                      ? "border-brand"
                      : "border-brand/35"
                    : isLatest
                      ? "border-foreground/60"
                      : "border-border-strong",
                  !turn.final && "text-foreground/75",
                )}
              >
                {isLatest && latestLabel ? (
                  <p aria-hidden className="mb-1 font-mono text-[11px] tracking-wider text-brand uppercase">
                    {latestLabel}
                  </p>
                ) : null}
                <p className={cn("break-words", isLatest && side === "ai" && "text-base leading-relaxed")}>
                  {turn.text || <span className="text-muted-foreground">…</span>}
                  {turn.interrupted ? (
                    <span className="ml-1.5 font-mono text-xs text-muted-foreground">(cut off)</span>
                  ) : null}
                </p>
              </div>
            </div>
          );
        })}
      </div>
      {overlay}
    </section>
  );
}
