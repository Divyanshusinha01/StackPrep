import { cn } from "@/lib/utils";

type WordmarkProps = {
  className?: string;
};

export function Wordmark({ className }: WordmarkProps) {
  return (
    <span className={cn("inline-flex items-center gap-2 font-semibold tracking-tight", className)}>
      <svg
        aria-hidden
        width={24}
        height={24}
        viewBox="0 0 24 24"
        fill="none"
        className="shrink-0"
      >
        <rect x={3} y={14} width={18} height={3} rx={1} className="fill-brand/35" />
        <rect x={5} y={10} width={14} height={3} rx={1} className="fill-brand/55" />
        <rect x={7} y={6} width={10} height={3} rx={1} className="fill-brand" />
        <path
          d="M12 3v2.5M10 4.5h4"
          stroke="currentColor"
          strokeWidth={1.25}
          strokeLinecap="round"
          className="text-foreground/80"
        />
        <rect x={10.5} y={2} width={3} height={2.5} rx={1.25} className="fill-foreground/90" />
      </svg>
      StackPrep
    </span>
  );
}
