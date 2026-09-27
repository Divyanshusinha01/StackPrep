"use client";

import { useRef } from "react";
import { m, useScroll } from "framer-motion";
import { ArrowDown } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useParallax } from "@/components/motion/parallax";
import { useReducedMotion } from "@/components/motion/use-reduced-motion";
import { CONNECT_GITHUB_HREF, CTA_GLOW } from "./constants";
import { GitHubMark } from "./github-mark";
/** Progress [0, 1] maps to [0, -distance]: planes start at rest while the hero is fully in view. */
const FROM_REST: [number, number] = [-1, 1];

const EASE = [0.22, 1, 0.36, 1] as const;

const fadeUp = (reduced: boolean, delay: number) =>
  reduced
    ? { initial: false as const, animate: { opacity: 1, y: 0 } }
    : {
        initial: { opacity: 0, y: 14 },
        animate: { opacity: 1, y: 0 },
        transition: { duration: 0.55, delay, ease: EASE },
      };

export function Hero() {
  const ref = useRef<HTMLElement>(null);
  const reduced = useReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end start"] });

  const gridY = useParallax(scrollYProgress, -120, FROM_REST);

  return (
    <section
      ref={ref}
      aria-labelledby="hero-heading"
      className="relative -mt-16 overflow-hidden pt-40 pb-16 sm:pt-48 lg:pt-36 lg:pb-28"
    >
      <m.div
        aria-hidden
        style={{ y: gridY }}
        className="pointer-events-none absolute inset-x-0 -top-24 h-[130%] bg-grid mask-radial"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 h-64 bg-linear-to-t from-background to-transparent"
      />

      <div className="relative mx-auto max-w-6xl px-6">
        <div className="text-center lg:text-left">
          <m.p
            className="mx-auto inline-flex items-center gap-2 rounded-full border border-white/5 bg-panel/80 px-3 py-1 font-mono text-xs text-muted-foreground lg:mx-0"
            {...fadeUp(reduced, 0)}
          >
            <span className="size-1.5 rounded-full bg-brand" aria-hidden />
            30-minute voice session · grounded in your files
          </m.p>
          <h1
            id="hero-heading"
            className="mt-6 font-display text-4xl tracking-[-0.04em] text-balance sm:text-5xl lg:text-[3.25rem] lg:leading-[1.06] xl:text-6xl xl:leading-[1.04]"
          >
            <m.span className="block font-medium text-foreground/95" {...fadeUp(reduced, 0.08)}>
              Defend the repo
            </m.span>
            <m.span className="mt-1 block font-semibold" {...fadeUp(reduced, 0.14)}>
              you actually <span className="text-gradient-brand">ship.</span>
            </m.span>
          </h1>
          <m.p
            className="mx-auto mt-6 max-w-xl text-base leading-relaxed text-pretty text-muted-foreground sm:text-lg lg:mx-0"
            {...fadeUp(reduced, 0.22)}
          >
            Connect GitHub, pick one repository, and talk through your architecture and
            trade-offs with an interviewer that cites your files—not a generic question bank.
          </m.p>
          <m.div
            className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row lg:justify-start"
            {...fadeUp(reduced, 0.3)}
          >
            <Button asChild size="lg" className={cn("h-11 px-5 text-[15px]", CTA_GLOW)}>
              <a href={CONNECT_GITHUB_HREF}>
                <GitHubMark className="size-4" />
                Connect GitHub
              </a>
            </Button>
            <Button
              asChild
              variant="ghost"
              size="lg"
              className="h-11 px-5 text-[15px] text-muted-foreground"
            >
              <a href="#how-it-works">
                See how it works
                <ArrowDown aria-hidden />
              </a>
            </Button>
          </m.div>
        </div>
      </div>
    </section>
  );
}
