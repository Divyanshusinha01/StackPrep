"use client";

import { AnimatePresence, m } from "framer-motion";

import { cn } from "@/lib/utils";
import { useReducedMotion } from "@/components/motion/use-reduced-motion";
import { WaveBars } from "../wave-bars";

const EASE = [0.22, 1, 0.36, 1] as const;
const WAVE = [35, 60, 90, 50, 100, 70, 40, 80, 55, 95, 45, 65, 30];

const CORE = {
  ai: "radial-gradient(circle at 35% 30%, oklch(0.93 0.06 88), var(--brand) 45%, oklch(0.32 0.08 88) 100%)",
  user: "radial-gradient(circle at 35% 30%, oklch(0.95 0.05 160), var(--success) 45%, oklch(0.34 0.08 160) 100%)",
};

/** Illustrative speaker indicator; the transcript panel beside it carries the real content. */
export function VoiceOrb({ speaker, className }: { speaker: "ai" | "user"; className?: string }) {
  const reduced = useReducedMotion();
  const isAI = speaker === "ai";
  const tone = isAI ? "brand" : "success";

  return (
    <div aria-hidden className={cn("flex flex-col items-center", className)}>
      <div className="relative grid size-40 place-items-center sm:size-48">
        <span
          className={cn(
            "absolute inset-2 rounded-full blur-2xl transition-colors duration-700",
            isAI ? "bg-brand/30" : "bg-success/25",
          )}
        />
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className={cn(
              "absolute inset-8 rounded-full border transition-colors duration-700 motion-safe:animate-[orb-ring_3s_ease-out_infinite]",
              isAI ? "border-brand/50" : "border-success/50",
            )}
            style={{ animationDelay: `${i}s` }}
          />
        ))}
        <span className="relative size-24 overflow-hidden rounded-full shadow-[inset_0_-8px_24px_rgb(0_0_0/0.35)] motion-safe:animate-[orb-breathe_4s_ease-in-out_infinite] sm:size-28">
          {(["ai", "user"] as const).map((key) => (
            <span
              key={key}
              className="absolute inset-0 transition-opacity duration-700"
              style={{ background: CORE[key], opacity: speaker === key ? 1 : 0 }}
            />
          ))}
        </span>
      </div>

      <WaveBars
        heights={WAVE}
        className="mt-4 h-6"
        barClassName={cn("transition-colors duration-700", tone === "brand" ? "bg-brand/80" : "bg-success/80")}
        stepMs={80}
        duration="1.1s"
      />

      <span className="relative mt-3 h-4 w-44 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
        <AnimatePresence mode="wait" initial={false}>
          <m.span
            key={speaker}
            className="absolute inset-0 text-center"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: reduced ? 0 : 0.3, ease: EASE }}
          >
            {isAI ? "StackPrep AI asking" : "You're answering"}
          </m.span>
        </AnimatePresence>
      </span>
    </div>
  );
}
