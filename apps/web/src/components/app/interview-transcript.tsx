import { Bot, Mic } from "lucide-react";
import type { TranscriptEntry } from "@/lib/api";

/** Read-only stored transcript, in sequence order. */
export function InterviewTranscript({ entries }: { entries: TranscriptEntry[] }) {
  if (entries.length === 0) {
    return <p className="mt-3 text-sm text-muted-foreground">No transcript was recorded for this interview.</p>;
  }
  return (
    <ol className="mt-4 space-y-4 text-sm leading-relaxed" data-testid="interview-transcript">
      {entries.map((entry) => (
        <li key={entry.id} className="flex gap-3">
          {entry.role === "ai" ? (
            <Bot className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden />
          ) : (
            <Mic className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          )}
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">{entry.role === "ai" ? "Interviewer" : "You"}</p>
            <p className="mt-0.5 whitespace-pre-wrap break-words">{entry.content}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}
