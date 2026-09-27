"use client";

import { useRef } from "react";
import { m, useScroll } from "framer-motion";
import { ArrowDown, ChevronRight, FileCode } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useParallax } from "@/components/motion/parallax";
import { useReducedMotion } from "@/components/motion/use-reduced-motion";
import { CONNECT_GITHUB_HREF, CTA_GLOW } from "./constants";
import { GitHubMark } from "./github-mark";
import { RepoPicker } from "./mockups/repo-picker";
import { RepoTree } from "./mockups/repo-tree";
import { WorkspacePanel } from "./mockups/workspace-panel";

/** Progress [0, 1] maps to [0, -distance]: planes start at rest while the hero is fully in view. */
const FROM_REST: [number, number] = [-1, 1];

const EASE = [0.22, 1, 0.36, 1] as const;
const MOBILE_STEPS = ["Connect", "Analyze", "Interview"];

const CHIPS = [
  { path: "src/auth/session.ts", className: "top-6 left-[42%]", delay: 0.7 },
  { path: "src/lib/queue.ts", className: "right-[34%] bottom-16", delay: 0.95 },
];

function FloatingChip({ path, className, delay }: (typeof CHIPS)[number]) {
  const reduced = useReducedMotion();
  return (
    <m.span
      className={cn(
        "absolute inline-flex items-center gap-1.5 rounded-md border border-brand/30 bg-panel-raised px-2.5 py-1 font-mono text-[11px] text-foreground/80 shadow-[0_8px_24px_-8px_rgb(0_0_0/0.6),0_0_24px_-8px_var(--brand-glow)]",
        className,
      )}
      initial={{ opacity: 0, scale: 0.85, y: 8 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={reduced ? { duration: 0 } : { duration: 0.6, delay, ease: EASE }}
    >
      <FileCode className="size-3 text-brand" />
      {path}
    </m.span>
  );
}

function StepLabel({ step, children }: { step: string; children: React.ReactNode }) {
  return (
    <p className="mb-2.5 hidden items-center gap-2 font-mono md:flex text-[11px] uppercase tracking-wider text-muted-foreground">
      <span className="text-brand">{step}</span>
      {children}
    </p>
  );
}

export function Hero() {
  const ref = useRef<HTMLElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end start"] });

  // Negative distances lag behind the scroll (far planes); positive ones outrun it (near planes).
  const gridY = useParallax(scrollYProgress, -180, FROM_REST);
  const glowY = useParallax(scrollYProgress, -120, FROM_REST);
  const pickerY = useParallax(scrollYProgress, -90, FROM_REST);
  const treeY = useParallax(scrollYProgress, -30, FROM_REST);
  const workspaceY = useParallax(scrollYProgress, 60, FROM_REST);
  const chipsY = useParallax(scrollYProgress, 150, FROM_REST);

  return (
    <section
      ref={ref}
      aria-labelledby="hero-heading"
      className="relative -mt-16 overflow-hidden pt-40 pb-16 sm:pt-48 lg:pt-40 lg:pb-24"
    >
      <m.div
        aria-hidden
        style={{ y: gridY }}
        className="pointer-events-none absolute inset-x-0 -top-24 h-[130%] bg-grid mask-radial"
      />
      <m.div
        aria-hidden
        style={{ y: glowY }}
        className="glow-brand pointer-events-none absolute inset-x-0 -top-40 mx-auto h-[40rem] w-[72rem] max-w-[160vw]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 h-64 bg-linear-to-t from-background to-transparent"
      />

      <div className="relative mx-auto max-w-4xl px-6 text-center">
        <p className="mx-auto inline-flex items-center gap-2 rounded-full border bg-panel/80 px-3 py-1 font-mono text-xs text-muted-foreground">
          <span className="size-1.5 rounded-full bg-brand" aria-hidden />
          Voice-first technical interviews on your own code
        </p>
        <h1
          id="hero-heading"
          className="mt-6 font-display text-4xl font-semibold tracking-[-0.04em] text-balance sm:text-6xl lg:text-7xl lg:leading-[1.02]"
        >
          Turn your codebase into <span className="text-gradient-brand">an interview.</span>
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-base leading-relaxed text-pretty text-muted-foreground sm:text-lg">
          Connect GitHub, pick a repository, and get interviewed by an AI that has read your
          code. Explain your architecture, defend your decisions, and see exactly where your
          understanding holds up.
        </p>
        <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Button
            asChild
            size="lg"
            className={cn("h-11 px-5 text-[15px]", CTA_GLOW)}
          >
            <a href={CONNECT_GITHUB_HREF}>
              <GitHubMark className="size-4" />
              Connect GitHub
            </a>
          </Button>
          <Button asChild variant="ghost" size="lg" className="h-11 px-5 text-[15px] text-muted-foreground">
            <a href="#how-it-works">
              See how it works
              <ArrowDown aria-hidden />
            </a>
          </Button>
        </div>
      </div>

      {/* Illustrative only; each stage is explained with real text in the sections below. */}
      <div
        aria-hidden
        className="relative mx-auto mt-14 max-w-6xl px-6 md:h-[480px] lg:mt-14 lg:h-[560px]"
      >
        <m.div
          style={{ y: pickerY }}
          className="absolute top-12 left-6 hidden w-[320px] opacity-75 md:block lg:w-[340px]"
        >
          <StepLabel step="01">Connect GitHub</StepLabel>
          <RepoPicker />
        </m.div>

        <m.div
          style={{ y: treeY }}
          className="absolute top-44 left-[34%] hidden w-[290px] opacity-90 lg:block"
        >
          <StepLabel step="02">Analyze repository</StepLabel>
          <RepoTree limit={9} highlight={["src/api/middleware.ts"]} showStack={false} />
        </m.div>

        <div className="mx-auto mb-5 max-w-md md:hidden">
          <ol className="flex items-center justify-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
            {MOBILE_STEPS.map((label, i) => (
              <li key={label} className="flex items-center gap-1.5">
                <span className={cn(i === 2 && "text-foreground")}>
                  <span className="text-brand">0{i + 1}</span> {label}
                </span>
                {i < MOBILE_STEPS.length - 1 ? <ChevronRight className="size-3 text-foreground/30" /> : null}
              </li>
            ))}
          </ol>
          <div className="mt-3 flex flex-wrap justify-center gap-2">
            {CHIPS.map(({ path }) => (
              <span
                key={path}
                className="inline-flex items-center gap-1.5 rounded-md border border-brand/30 bg-panel-raised px-2 py-0.5 font-mono text-[11px] text-foreground/80"
              >
                <FileCode className="size-3 text-brand" />
                {path}
              </span>
            ))}
          </div>
        </div>

        <m.div
          style={{ y: workspaceY }}
          className="relative mx-auto max-w-md md:absolute md:top-0 md:right-6 md:w-[420px] md:max-w-none lg:w-[440px]"
        >
          <span
            aria-hidden
            className="glow-brand pointer-events-none absolute -inset-x-24 -inset-y-16 -z-10 opacity-80"
          />
          <StepLabel step="03">Interview-ready workspace</StepLabel>
          <WorkspacePanel glow />
        </m.div>

        <m.div style={{ y: chipsY }} className="pointer-events-none absolute inset-0 hidden lg:block">
          {CHIPS.map((chip) => (
            <FloatingChip key={chip.path} {...chip} />
          ))}
        </m.div>
      </div>
    </section>
  );
}
