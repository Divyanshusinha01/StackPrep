"use client";

import { useEffect, useState } from "react";
import { m, useScroll, useSpring } from "framer-motion";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useReducedMotion } from "@/components/motion/use-reduced-motion";
import { CONNECT_GITHUB_HREF, SECTIONS } from "./constants";
import { GitHubMark } from "./github-mark";

export function Wordmark() {
  return (
    <span className="inline-flex items-center gap-2 font-semibold tracking-tight">
      <span
        aria-hidden
        className="grid size-6 place-items-center rounded-md bg-brand font-mono text-[11px] font-bold text-primary-foreground"
      >
        {">_"}
      </span>
      StackPrep
    </span>
  );
}

function useActiveSection() {
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    const visible = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target.id);
          else visible.delete(entry.target.id);
        }
        setActive(SECTIONS.find((s) => visible.has(s.id))?.id ?? null);
      },
      { rootMargin: "-45% 0px -50% 0px" },
    );
    for (const { id } of SECTIONS) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, []);

  return active;
}

export function SiteHeader() {
  const [scrolled, setScrolled] = useState(false);
  const active = useActiveSection();
  const reduced = useReducedMotion();
  const { scrollYProgress } = useScroll();
  const progress = useSpring(scrollYProgress, { stiffness: 200, damping: 40, restDelta: 0.001 });

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
          <Wordmark />
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
                      "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px] outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50",
                      current ? "text-foreground" : "text-muted-foreground hover:text-foreground",
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

        <Button asChild size="sm" className="ml-auto md:ml-0">
          <a href={CONNECT_GITHUB_HREF}>
            <GitHubMark className="size-3.5" />
            Connect GitHub
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
