"use client";

import { cn } from "@/lib/utils";
import { useReducedMotion } from "@/components/motion/use-reduced-motion";
import { SECTIONS } from "./constants";
import { useActiveSection } from "./use-active-section";

export function ScrollSpine() {
  const active = useActiveSection();
  const reduced = useReducedMotion();

  return (
    <nav
      aria-label="Page sections"
      className={cn(
        "fixed top-1/2 z-40 hidden -translate-y-1/2 flex-col gap-3 xl:left-6 xl:flex",
        reduced && "motion-reduce:opacity-90",
      )}
    >
      {SECTIONS.map(({ id, step, label }) => {
        const current = active === id;
        return (
          <a
            key={id}
            href={`#${id}`}
            aria-current={current ? "location" : undefined}
            className={cn(
              "group flex items-center gap-2 rounded-md py-0.5 pr-2 outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50",
              current ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <span
              className={cn(
                "size-2 rounded-full border transition-[background-color,border-color,box-shadow] duration-300",
                current
                  ? "border-brand bg-brand shadow-[0_0_12px_-2px_var(--brand-glow)]"
                  : "border-muted-foreground/40 bg-transparent group-hover:border-brand/50",
              )}
              aria-hidden
            />
            <span className="flex flex-col leading-none opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-visible:opacity-100">
              <span className="font-mono text-[10px] text-brand">{step}</span>
              <span className="text-[11px]">{label}</span>
            </span>
          </a>
        );
      })}
    </nav>
  );
}
