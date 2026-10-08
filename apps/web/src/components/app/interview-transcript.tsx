import { Bot, Mic } from "lucide-react";
import type { TranscriptEntry } from "@/lib/api";
import { cn } from "@/lib/utils";

/** Read-only stored transcript, in sequence order. */
export function InterviewTranscript({ entries }: { entries: TranscriptEntry[] }) {
  if (entries.length === 0) {
    return <p className="mt-3 text-sm text-muted-foreground">No transcript was recorded for this interview.</p>;
  }
  return (
    <ol className="mt-4 flex flex-col gap-4 text-sm leading-relaxed" data-testid="interview-transcript">
      {entries.map((entry) => {
        const ai = entry.role === "ai";
        return (
          <li
            key={entry.id}
            className={cn("flex max-w-[92%] gap-2.5 sm:max-w-[80%] print:max-w-none", ai ? "self-start" : "flex-row-reverse self-end")}
          >
            <span
              aria-hidden
              className={cn(
                "mt-5 grid size-7 shrink-0 place-items-center rounded-full border print:hidden",
                ai ? "bg-brand-muted text-brand" : "bg-panel-raised text-muted-foreground",
              )}
            >
              {ai ? <Bot className="size-3.5" /> : <Mic className="size-3.5" />}
            </span>
            <div className={cn("min-w-0", !ai && "text-right")}>
              <p className="text-xs font-medium text-muted-foreground">{ai ? "Interviewer" : "You"}</p>
              <p
                className={cn(
                  "mt-1 rounded-2xl border px-3.5 py-2.5 text-left break-words whitespace-pre-wrap print:border-0 print:p-0",
                  ai ? "rounded-tl-sm bg-panel-raised" : "rounded-tr-sm border-brand/20 bg-brand-muted",
                )}
              >
                {entry.content}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
