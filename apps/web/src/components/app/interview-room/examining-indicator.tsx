import { FileSearch } from "lucide-react";
import { type ExaminedItem, examiningLabel } from "@/components/app/examining";

/** Which file or module the interviewer is looking at; paths only, never content or reasoning. */
export function ExaminingIndicator({ items }: { items: ExaminedItem[] | null }) {
  const label = items ? examiningLabel(items) : "";
  return (
    <p
      aria-live="polite"
      title={items?.map((item) => item.path).join("\n")}
      className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-start p-2.5"
    >
      {label ? (
        <span className="pointer-events-auto inline-flex max-w-full items-center gap-2 rounded-lg border border-brand/35 bg-background/95 px-3 py-1.5 text-xs text-foreground shadow-lg shadow-black/40 backdrop-blur-md motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1">
          <FileSearch className="size-3.5 shrink-0 text-brand" aria-hidden />
          <span className="truncate font-mono text-[11px]">{label}</span>
        </span>
      ) : null}
    </p>
  );
}
