"use client";

import { useRef, useState } from "react";
import { m, useMotionValueEvent, useScroll, useTransform } from "framer-motion";

import { cn } from "@/lib/utils";
import { ScrollReveal } from "@/components/motion/scroll-reveal";
import { useReducedMotion } from "@/components/motion/use-reduced-motion";
import { SectionHeading } from "./section-heading";

const STEPS = [
  { title: "Architecture", body: "How the system is structured and how a request moves through it." },
  { title: "Design decisions", body: "Why you chose this approach over the alternatives you had." },
  { title: "Implementation", body: "How specific modules actually work under the hood." },
  { title: "Trade-offs", body: "What you gave up, and whether you’d make the same call again." },
  { title: "Edge cases", body: "Failure modes, retries, race conditions, and what breaks first." },
];

export function TechnicalDepth() {
  const listRef = useRef<HTMLOListElement>(null);
  const reduced = useReducedMotion();
  const { scrollYProgress } = useScroll({
    target: listRef,
    offset: ["start 0.7", "end 0.55"],
  });
  const fill = useTransform(scrollYProgress, [0, 1], [0, 1]);
  const [reachedCount, setReachedCount] = useState(0);

  // Circles sit evenly along the line, so step i is reached once the fill passes i / (n - 1).
  useMotionValueEvent(fill, "change", (value) => {
    setReachedCount(Math.floor(value * (STEPS.length - 1) + 0.05) + 1);
  });

  const reached = reduced ? STEPS.length : reachedCount;

  return (
    <section
      id="depth"
      aria-labelledby="depth-heading"
      className="relative scroll-mt-20 border-t py-24 sm:py-32"
    >
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-dots mask-fade-y opacity-70" />
      <div className="relative mx-auto grid max-w-6xl grid-cols-1 gap-14 px-6 lg:grid-cols-2 lg:gap-20">
        <ScrollReveal className="lg:sticky lg:top-24 lg:self-start">
          <SectionHeading id="depth-heading" eyebrow="04 — Depth" title="Beyond what it does. Into why.">
            Questions move from how the system fits together to the reasoning behind it, and
            then to where it could break. Surface-level answers get a follow-up.
          </SectionHeading>
        </ScrollReveal>

        <ol ref={listRef} className="relative divide-y divide-border/60">
          <span aria-hidden className="absolute top-6 bottom-6 left-[19px] w-px bg-border" />
          <m.span
            aria-hidden
            className="absolute top-6 bottom-6 left-[19px] w-px origin-top bg-linear-to-b from-brand to-success"
            style={{ scaleY: reduced ? 1 : fill }}
          />
          {STEPS.map((step, i) => (
            <li key={step.title} className="relative py-4 first:pt-0 last:pb-0">
              <ScrollReveal delay={i * 0.06} className="flex items-start gap-5">
                <span
                  className={cn(
                    "relative z-10 mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-full border bg-panel font-mono text-xs transition-[color,border-color,box-shadow] duration-500",
                    i < reached
                      ? "border-brand/60 text-brand shadow-[0_0_0_4px_var(--brand-muted),0_0_24px_-4px_var(--brand-glow)]"
                      : "text-muted-foreground",
                  )}
                >
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="flex-1 pt-1">
                  <span
                    className={cn(
                      "block font-display text-base font-medium transition-colors duration-500",
                      i < reached ? "text-foreground" : "text-foreground/80",
                    )}
                  >
                    {step.title}
                  </span>
                  <span className="mt-1 block text-sm leading-relaxed text-muted-foreground">{step.body}</span>
                </span>
              </ScrollReveal>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
