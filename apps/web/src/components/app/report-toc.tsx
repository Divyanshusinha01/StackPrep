"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/** In-page contents for the report; highlights the section currently near the top of the viewport. */
export function ReportToc({ items }: { items: readonly { id: string; label: string }[] }) {
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    const visible = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            visible.add(entry.target.id);
          } else {
            visible.delete(entry.target.id);
          }
        }
        const first = items.find((item) => visible.has(item.id));
        if (first) {
          setActive(first.id);
        }
      },
      { rootMargin: "-15% 0px -65% 0px" },
    );
    for (const { id } of items) {
      const el = document.getElementById(id);
      if (el) {
        observer.observe(el);
      }
    }
    return () => observer.disconnect();
  }, [items]);

  return (
    <nav aria-label="Report sections" className="print:hidden">
      <p className="hidden font-mono text-[11px] font-medium tracking-wider text-muted-foreground uppercase lg:block">
        On this page
      </p>
      <ol className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 lg:mx-0 lg:mt-3 lg:flex-col lg:gap-0.5 lg:overflow-visible lg:border-l lg:border-border/80 lg:px-0 lg:pb-0">
        {items.map((item) => {
          const current = active === item.id;
          return (
            <li key={item.id} className="shrink-0">
              <a
                href={`#${item.id}`}
                aria-current={current ? "location" : undefined}
                className={cn(
                  "focus-ring block rounded-full border px-3 py-1.5 text-xs whitespace-nowrap transition-colors",
                  "lg:-ml-px lg:rounded-none lg:border-0 lg:border-l-2 lg:py-1.5 lg:pr-2 lg:pl-3.5 lg:text-[13px] lg:whitespace-normal",
                  current
                    ? "border-brand/40 bg-brand-muted font-medium text-foreground lg:border-brand lg:bg-transparent lg:text-brand"
                    : "text-muted-foreground hover:text-foreground lg:border-transparent",
                )}
              >
                {item.label}
              </a>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
