import { cn } from "@/lib/utils";

/** Decorative animated voice waveform; bar heights are percentages of the container height. */
export function WaveBars({
  heights,
  className,
  barClassName,
  stepMs = 90,
  duration = "1.2s",
}: {
  heights: readonly number[];
  /** Sets the container height, e.g. `h-5`. */
  className?: string;
  /** Bar colour and width, e.g. `w-[3px] bg-brand/70`. */
  barClassName?: string;
  /** Delay between neighbouring bars. */
  stepMs?: number;
  duration?: string;
}) {
  return (
    <span aria-hidden className={cn("flex items-center gap-[3px]", className)}>
      {heights.map((h, i) => (
        <span
          key={i}
          className={cn(
            "w-[3px] origin-center rounded-full bg-brand/70 motion-safe:animate-[wave_1.2s_ease-in-out_infinite]",
            barClassName,
          )}
          style={{ height: `${h}%`, animationDelay: `${i * stepMs}ms`, animationDuration: duration }}
        />
      ))}
    </span>
  );
}
