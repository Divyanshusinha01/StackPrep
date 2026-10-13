import { Bot, Mic } from "lucide-react";
import type { TranscriptEntry } from "@/lib/api";
import { cn } from "@/lib/utils";

/** Read-only stored transcript, in sequence order. */
export function InterviewTranscript({ entries }: { entries: TranscriptEntry[] }) {
  if (entries.length === 0) {
    return <p className="mt-3 text-sm text-muted-foreground">No transcript was recorded for this interview.</p>;
  }
  return (
    <ol
      className="mt-2 divide-y divide-border/60 text-sm leading-relaxed print:divide-border"
      data-testid="interview-transcript"
    >
      {entries.map((entry) => {
        const ai = entry.role === "ai";
        return (
          <li
            key={entry.id}
            className="grid gap-1.5 py-3.5 sm:grid-cols-[8.5rem_minmax(0,1fr)] sm:items-baseline sm:gap-4 print:break-inside-avoid"
          >
            <div className="flex items-center gap-2">
              <span
                aria-hidden
                className={cn(
                  "grid size-5 shrink-0 place-items-center rounded border print:hidden",
                  ai
                    ? "border-brand/30 bg-brand-muted text-brand"
                    : "border-border-strong/60 bg-panel-raised text-muted-foreground",
                )}
              >
                {ai ? <Bot className="size-3" /> : <Mic className="size-3" />}
              </span>
              <span
                className={cn(
                  "font-mono text-xs font-medium",
                  ai ? "text-brand print:text-foreground" : "text-muted-foreground print:text-foreground",
                )}
              >
                {ai ? "Interviewer" : "You"}
              </span>
            </div>
            <p className="min-w-0 break-words whitespace-pre-wrap text-foreground/95">{entry.content}</p>
          </li>
        );
      })}
    </ol>
  );
}
