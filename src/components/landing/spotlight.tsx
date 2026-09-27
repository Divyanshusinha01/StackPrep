"use client";

import { cn } from "@/lib/utils";

type SpotlightProps = {
  children: React.ReactNode;
  className?: string;
};

/** Soft brand light that follows the pointer while hovering; hover-capable devices only. */
export function Spotlight({ children, className }: SpotlightProps) {
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    event.currentTarget.style.setProperty("--spot-x", `${event.clientX - rect.left}px`);
    event.currentTarget.style.setProperty("--spot-y", `${event.clientY - rect.top}px`);
  };

  return (
    <div onPointerMove={onPointerMove} className={cn("group/spot relative", className)}>
      {children}
      <span
        aria-hidden
        className="spotlight-glow pointer-events-none absolute inset-0 rounded-[inherit] opacity-0 transition-opacity duration-300 group-hover/spot:opacity-100"
      />
    </div>
  );
}
