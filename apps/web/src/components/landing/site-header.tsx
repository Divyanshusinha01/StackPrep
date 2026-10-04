"use client";

import { useEffect, useState } from "react";
import { m, useScroll, useSpring } from "framer-motion";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useReducedMotion } from "@/components/motion/use-reduced-motion";
import { CTA_GLOW, SECTIONS, primaryCta } from "./constants";
import { GitHubMark } from "./github-mark";
import { useActiveSection } from "./use-active-section";
import { Wordmark } from "./wordmark";

export { Wordmark } from "./wordmark";

export function SiteHeader({ signedIn }: { signedIn: boolean }) {
  const cta = primaryCta(signedIn);
  const [scrolled, setScrolled] = useState(false);
  const active = useActiveSection();
  const reduced = useReducedMotion();
  const { scrollYProgress } = useScroll();
  const progress = useSpring(scrollYProgress, { stiffness: 200, damping: 40, restDelta: 0.001 });
  const interviewLive = active === "interview";

  useEffect(() => {
    const update = () => setScrolled(window.scrollY > 8);
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, []);

  return (
    <header
      className={cn(
        "sticky top-0 z-50 border-b transition-[background-color,border-color,backdrop-filter] duration-300",
        scrolled
          ? "border-border bg-background/80 backdrop-blur-md"
          : "border-transparent bg-transparent",
      )}
    >
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-6">
        <a
          href="#top"
          className="rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          aria-label="StackPrep home"
        >
          <span className="inline-flex items-center gap-2">
            <Wordmark />
            {interviewLive ? (
              <span
                className="relative flex size-4 items-center justify-center"
                aria-hidden
                title="Interview section"
              >
                <span className="absolute inset-0 rounded-full border border-brand/60 motion-safe:animate-ping" />
                <span className="size-2 rounded-full bg-brand" />
              </span>
            ) : null}
          </span>
        </a>

        <nav aria-label="Sections" className="mx-auto hidden md:block">
          <ul className="flex items-center gap-1">
            {SECTIONS.map(({ id, step, label }) => {
              const current = active === id;
              return (
                <li key={id}>
                  <a
                    href={`#${id}`}
                    aria-current={current ? "location" : undefined}
                    className={cn(
                      "flex items-center gap-1.5 rounded-md border-b-2 px-2.5 py-1.5 text-[13px] outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50",
                      current
                        ? "border-brand text-foreground"
                        : "border-transparent text-muted-foreground hover:border-brand/30 hover:text-foreground",
                    )}
                  >
                    <span
                      className={cn(
                        "font-mono text-[11px] transition-colors",
                        current ? "text-brand" : "text-muted-foreground/60",
                      )}
                    >
                      {step}
                    </span>
                    {label}
                  </a>
                </li>
              );
            })}
          </ul>
        </nav>

        <Button asChild size="sm" className={cn("ml-auto md:ml-0", CTA_GLOW)}>
          <a href={cta.href}>
            <GitHubMark className="size-3.5" />
            {cta.label}
          </a>
        </Button>
      </div>

      <m.div
        aria-hidden
        className="absolute inset-x-0 -bottom-px h-0.5 origin-left bg-linear-to-r from-brand to-success"
        style={{ scaleX: reduced ? scrollYProgress : progress }}
      />
    </header>
  );
}
