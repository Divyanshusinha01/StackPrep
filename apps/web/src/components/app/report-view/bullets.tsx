import { ArrowUpRight, Check, Target } from "lucide-react";
import { cn } from "@/lib/utils";

const VARIANTS = {
  success: { marker: "border-success/35 bg-success/10 text-success", Icon: Check },
  warning: { marker: "border-warning/35 bg-warning/10 text-warning", Icon: Target },
  brand: { marker: "border-brand/35 bg-brand-muted text-brand", Icon: ArrowUpRight },
} as const;

export function Bullets({
  items,
  empty,
  variant = "brand",
}: {
  items: string[];
  empty: string;
  variant?: keyof typeof VARIANTS;
}) {
  if (items.length === 0) {
    return <p className="mt-2.5 text-sm text-muted-foreground">{empty}</p>;
  }
  const { marker, Icon } = VARIANTS[variant];
  return (
    <ul className="mt-3.5 space-y-2.5 text-sm leading-relaxed">
      {items.map((item, i) => (
        <li key={i} className="flex items-start gap-3">
          <span
            aria-hidden
            className={cn("mt-1 grid size-4.5 shrink-0 place-items-center rounded-full border", marker)}
          >
            <Icon className="size-3" />
          </span>
          <span className="min-w-0 flex-1 text-foreground/95">{item}</span>
        </li>
      ))}
    </ul>
  );
}
