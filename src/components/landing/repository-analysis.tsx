"use client";

import { useRef } from "react";
import { m, useScroll, useTransform, type MotionValue } from "framer-motion";
import { Boxes, Layers, Lock, Waypoints } from "lucide-react";

import { Parallax } from "@/components/motion/parallax";
import { ScrollReveal } from "@/components/motion/scroll-reveal";
import { useReducedMotion } from "@/components/motion/use-reduced-motion";
import { REPO_TREE, RepoTree, TREE_ROW_HEIGHT, treeRowIndex } from "./mockups/repo-tree";
import { SectionHeading } from "./section-heading";

const LINKS: [string, string][] = [
  ["src/api/middleware.ts", "src/auth/session.ts"],
  ["src/auth/session.ts", "src/lib/db.ts"],
  ["src/api/webhooks.ts", "src/lib/queue.ts"],
];

const HIGHLIGHTED = Array.from(new Set(LINKS.flat()));

const SIGNALS = [
  { icon: Layers, label: "Stack", value: "Next.js, TypeScript, PostgreSQL, Stripe" },
  { icon: Waypoints, label: "Architecture", value: "API routes → middleware → services → data layer" },
  { icon: Lock, label: "Authentication", value: "OAuth sign-in with server-side sessions" },
  { icon: Boxes, label: "Async work", value: "Webhook events processed through a job queue" },
];

function rowCenter(path: string) {
  return treeRowIndex(path) * TREE_ROW_HEIGHT + TREE_ROW_HEIGHT / 2;
}

function LinkPath({
  from,
  to,
  opacity,
}: {
  from: string;
  to: string;
  opacity?: MotionValue<number>;
}) {
  const y1 = rowCenter(from);
  const y2 = rowCenter(to);
  const bend = Math.min(44, 14 + (y2 - y1) / 6);
  return (
    <m.g style={{ opacity: opacity ?? 1 }}>
      <path
        d={`M 4 ${y1} C ${bend} ${y1}, ${bend} ${y2}, 4 ${y2}`}
        fill="none"
        stroke="var(--brand)"
        strokeOpacity={0.7}
        strokeWidth={1.25}
        strokeDasharray="3 3"
      />
      <circle cx={4} cy={y1} r={2.5} fill="var(--brand)" />
      <circle cx={4} cy={y2} r={2.5} fill="var(--brand)" />
    </m.g>
  );
}

export function RepositoryAnalysis() {
  const treeRef = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const { scrollYProgress } = useScroll({
    target: treeRef,
    offset: ["start 0.85", "center 0.45"],
  });
  const opacities = [
    useTransform(scrollYProgress, [0, 0.4], [0, 1]),
    useTransform(scrollYProgress, [0.3, 0.7], [0, 1]),
    useTransform(scrollYProgress, [0.6, 1], [0, 1]),
  ];

  const overlay = (
    <svg
      aria-hidden
      className="pointer-events-none absolute top-0 right-2"
      width={56}
      height={REPO_TREE.length * TREE_ROW_HEIGHT}
    >
      {LINKS.map(([from, to], i) => (
        <LinkPath key={from + to} from={from} to={to} opacity={reduced ? undefined : opacities[i]} />
      ))}
    </svg>
  );

  return (
    <section
      id="analysis"
      aria-labelledby="analysis-heading"
      className="relative scroll-mt-20 overflow-hidden border-t py-24 sm:py-32"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-0 w-full bg-dots mask-fade-y opacity-80 lg:w-1/2"
      />
      <div
        aria-hidden
        className="glow-brand pointer-events-none absolute top-1/2 left-1/4 h-[32rem] w-[40rem] -translate-x-1/2 -translate-y-1/2 opacity-50"
      />
      <div className="relative mx-auto grid max-w-6xl grid-cols-1 items-center gap-14 px-6 lg:grid-cols-2 lg:gap-20">
        <div ref={treeRef} className="order-2 lg:order-1">
          <Parallax distance={30}>
            <RepoTree className="mx-auto max-w-md" highlight={HIGHLIGHTED} overlay={overlay} />
          </Parallax>
        </div>

        <div className="order-1 lg:order-2">
          <ScrollReveal>
            <SectionHeading id="analysis-heading" eyebrow="02 — Analyze" title="Your interview starts with your code.">
              StackPrep maps the structure of your repository: its modules, frameworks, and how
              the pieces connect. Every question is grounded in something you actually built.
            </SectionHeading>
          </ScrollReveal>

          <ul className="mt-10 space-y-3">
            {SIGNALS.map(({ icon: Icon, label, value }, i) => (
              <li key={label}>
                <ScrollReveal delay={i * 0.08}>
                  <div className="flex items-start gap-4 rounded-lg border bg-panel/60 p-4">
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-background text-brand">
                      <Icon className="size-4" aria-hidden />
                    </span>
                    <span>
                      <span className="block font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
                        {label}
                      </span>
                      <span className="mt-1 block text-sm text-foreground/90">{value}</span>
                    </span>
                  </div>
                </ScrollReveal>
              </li>
            ))}
          </ul>

          <p className="mt-6 text-sm text-muted-foreground">
            Deeper analysis keeps running in the background. You can start as soon as the
            baseline is ready.
          </p>
        </div>
      </div>
    </section>
  );
}
