import { cn } from "@/lib/utils";

/** Three bouncing bars while someone is talking; a still dot otherwise. Decorative only. */
export function VoiceActivity({ active, label }: { active: boolean; label: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors",
        active ? "bg-brand-muted text-brand" : "text-muted-foreground",
      )}
    >
      <span aria-hidden className="flex h-3 items-end gap-[2px]">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className={cn(
              "w-[3px] origin-bottom rounded-full bg-current",
              active ? "h-3 motion-safe:animate-[wave_0.9s_ease-in-out_infinite]" : "h-1",
            )}
            style={active ? { animationDelay: `${i * 0.15}s` } : undefined}
          />
        ))}
      </span>
      {label}
    </span>
  );
}
