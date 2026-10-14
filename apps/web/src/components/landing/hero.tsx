"use client";

import { useRef } from "react";
import { m, useScroll } from "framer-motion";
import { ArrowDown, FileCode2, FolderGit2, GitBranch, Mic } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useParallax } from "@/components/motion/parallax";
import { useReducedMotion } from "@/components/motion/use-reduced-motion";
import { AuthCta } from "./auth-cta";
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

/** Slide only: text that starts at opacity 0 stays invisible until hydration, which delays LCP. */
const slideUp = (reduced: boolean, delay: number) =>
  reduced
    ? { initial: false as const, animate: { y: 0 } }
    : { initial: { y: 14 }, animate: { y: 0 }, transition: { duration: 0.55, delay, ease: EASE } };

const HERO_TREE = [
  { path: "src/auth/session.ts", lines: "L14–89", active: true },
  { path: "src/api/middleware.ts", lines: "L22–64", active: false },
  { path: "src/db/transactions.ts", lines: "L8–112", active: false },
] as const;

const HERO_WAVE = [35, 70, 95, 55, 100, 65, 40, 85, 60, 90, 50, 75, 45, 65];

export function Hero() {
  const ref = useRef<HTMLElement>(null);
  const reduced = useReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end start"] });

  const gridY = useParallax(scrollYProgress, -120, FROM_REST);

  return (
    <section
      ref={ref}
      aria-labelledby="hero-heading"
      className="relative -mt-16 overflow-hidden pt-36 pb-16 sm:pt-44 lg:pt-36 lg:pb-28"
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
        <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:items-center lg:gap-12">
          <div className="text-center lg:text-left">
            <m.p
              className="mx-auto inline-flex items-center gap-2 rounded-full border border-border-strong/80 bg-panel/80 px-3 py-1 font-mono text-xs text-muted-foreground lg:mx-0"
              {...fadeUp(reduced, 0)}
            >
              <span className="size-1.5 rounded-full bg-brand" aria-hidden />
              30-minute voice session · grounded in your files
            </m.p>
            <h1
              id="hero-heading"
              className="mt-6 font-display text-4xl tracking-[-0.04em] text-balance sm:text-5xl lg:text-[3.25rem] lg:leading-[1.06] xl:text-6xl xl:leading-[1.04]"
            >
              <m.span className="block font-medium text-foreground/95" {...slideUp(reduced, 0.08)}>
                Defend the repo
              </m.span>
              <m.span className="mt-1 block font-semibold" {...slideUp(reduced, 0.14)}>
                you actually <span className="text-gradient-brand">ship.</span>
              </m.span>
            </h1>
            <m.p
              className="mx-auto mt-6 max-w-xl text-base leading-relaxed text-pretty text-muted-foreground sm:text-lg lg:mx-0"
              {...slideUp(reduced, 0.22)}
            >
              Connect GitHub, pick one repository, and talk through your architecture and
              trade-offs with an interviewer that cites your files—not a generic question bank.
            </m.p>
            <m.div
              className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row lg:justify-start"
              {...fadeUp(reduced, 0.3)}
            >
              <AuthCta location="hero" size="lg" className="h-11 px-5 text-[15px]" />
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

          <m.div
            aria-hidden
            className="mt-12 lg:mt-0"
            {...fadeUp(reduced, 0.2)}
          >
            <div className="surface-inset relative overflow-hidden rounded-xl border border-border-strong/70 bg-panel/90 shadow-2xl">
              <div className="flex items-center justify-between border-b px-4 py-3 text-xs">
                <span className="flex items-center gap-2 font-mono text-foreground/90">
                  <FolderGit2 className="size-3.5 text-brand" />
                  <span className="text-muted-foreground">acme /</span> payments-service
                </span>
                <span className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
                  <GitBranch className="size-3" />
                  main · 8f3a19c
                </span>
              </div>

              <div className="divide-y">
                <div className="bg-background/40 px-4 py-3">
                  <p className="font-mono text-[10px] tracking-wider text-muted-foreground uppercase">
                    Indexed scope
                  </p>
                  <ul className="mt-2 space-y-1.5 font-mono text-xs">
                    {HERO_TREE.map((item) => (
                      <li
                        key={item.path}
                        className={cn(
                          "flex items-center justify-between rounded-md px-2.5 py-1.5",
                          item.active
                            ? "border border-brand/30 bg-brand-muted/60 text-foreground"
                            : "text-muted-foreground",
                        )}
                      >
                        <span className="flex items-center gap-2 truncate">
                          <FileCode2
                            className={cn("size-3.5 shrink-0", item.active ? "text-brand" : "text-muted-foreground/70")}
                          />
                          <span className="truncate">{item.path}</span>
                        </span>
                        <span className={cn("text-[11px]", item.active ? "text-brand" : "text-muted-foreground/70")}>
                          {item.lines}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="p-4 sm:p-5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-brand">
                      <span className="size-1.5 rounded-full bg-brand motion-safe:animate-pulse" />
                      Examining src/auth/session.ts
                    </span>
                    <span className="font-mono text-[11px] text-muted-foreground tabular-nums">12:40 / 30:00</span>
                  </div>

                  <div className="mt-3.5 border-l-2 border-brand/60 pl-3.5">
                    <p className="font-mono text-[11px] text-muted-foreground">Interviewer</p>
                    <p className="mt-1 text-sm leading-relaxed text-foreground">
                      “You rotate the refresh token inside <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-brand">rotateSession()</code> before committing the response. What happens if two requests race on the same cookie?”
                    </p>
                  </div>

                  <div className="mt-4 flex items-center justify-between rounded-lg border bg-background/60 px-3.5 py-2.5">
                    <span className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Mic className="size-3.5 text-brand" />
                      Voice channel active
                    </span>
                    <span className="flex h-4 items-center gap-[3px]">
                      {HERO_WAVE.map((h, i) => (
                        <span
                          key={i}
                          className="w-[2.5px] rounded-full bg-brand/75 motion-safe:animate-[wave_1.2s_ease-in-out_infinite]"
                          style={{ height: `${h}%`, animationDelay: `${i * 80}ms` }}
                        />
                      ))}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </m.div>
        </div>
      </div>
    </section>
  );
}
