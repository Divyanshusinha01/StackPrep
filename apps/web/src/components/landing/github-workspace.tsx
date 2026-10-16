"use client";

import { useRef } from "react";
import { m, useScroll, useTransform } from "framer-motion";
import { ArrowRight } from "lucide-react";

import { ScrollReveal } from "@/components/motion/scroll-reveal";
import { useIsDesktop } from "@/components/motion/use-media-query";
import { useReducedMotion } from "@/components/motion/use-reduced-motion";
import { GitHubMark } from "./github-mark";
import { RepoPicker } from "./mockups/repo-picker";
import { WorkspacePanel } from "./mockups/workspace-panel";
import { SectionHeading } from "./section-heading";

export function GitHubWorkspace() {
  const stageRef = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const isDesktop = useIsDesktop();
  const morph = isDesktop && !reduced;

  const { scrollYProgress } = useScroll({
    target: stageRef,
    offset: ["start end", "center center"],
  });

  // The workspace starts tucked behind the repository and slides out as the section centres.
  const pickerX = useTransform(scrollYProgress, [0, 1], [160, 0]);
  const pickerScale = useTransform(scrollYProgress, [0, 1], [1, 0.94]);
  const pickerOpacity = useTransform(scrollYProgress, [0.4, 1], [1, 0.65]);
  const workspaceX = useTransform(scrollYProgress, [0, 1], [-200, 0]);
  const workspaceScale = useTransform(scrollYProgress, [0, 1], [0.85, 1]);
  const workspaceOpacity = useTransform(scrollYProgress, [0, 0.8], [0.25, 1]);
  const connectorOpacity = useTransform(scrollYProgress, [0.6, 1], [0, 1]);

  // Explicit resting values: passing `undefined` would leave Framer's last inline styles in place.
  const rest = { x: 0, scale: 1, opacity: 1 };

  const reveal = (node: React.ReactNode, delay = 0) =>
    morph ? node : <ScrollReveal delay={delay}>{node}</ScrollReveal>;

  return (
    <section
      id="how-it-works"
      aria-labelledby="workspace-heading"
      className="relative scroll-mt-20 py-24 sm:py-32"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-full max-h-[480px] bg-grid mask-radial opacity-50"
      />
      <div className="relative mx-auto max-w-6xl px-6">
        <ScrollReveal>
          <SectionHeading id="workspace-heading" eyebrow="01 — Connect" title="One repository. One workspace." align="center">
            Pick a repository and StackPrep opens a permanent workspace for it. Every interview
            and report you do on that codebase lives there, ready when you come back. Your OpenAI
            key is set up first, right after you sign in.
          </SectionHeading>
        </ScrollReveal>

        <div
          ref={stageRef}
          className="mt-16 grid grid-cols-1 items-center gap-8 lg:mt-20 lg:grid-cols-[1fr_auto_1fr] lg:gap-6"
        >
          <m.div
            className="relative z-10 mx-auto w-full max-w-md"
            style={morph ? { x: pickerX, scale: pickerScale, opacity: pickerOpacity } : rest}
          >
            {reveal(<RepoPicker />)}
          </m.div>

          <m.p
            className="flex items-center justify-center gap-2 font-mono text-xs text-muted-foreground lg:flex-col lg:gap-3"
            style={{ opacity: morph ? connectorOpacity : 1 }}
          >
            <span className="inline-flex items-center gap-1.5">
              <GitHubMark className="size-3.5" />
              GitHub repository
            </span>
            <ArrowRight className="size-4 rotate-90 text-brand lg:rotate-0" aria-hidden />
            <span className="sr-only">becomes a</span>
            <span>StackPrep workspace</span>
          </m.p>

          <m.div
            className="relative mx-auto w-full max-w-md"
            style={morph ? { x: workspaceX, scale: workspaceScale, opacity: workspaceOpacity } : rest}
          >
            {reveal(<WorkspacePanel glow />, 0.1)}
          </m.div>
        </div>
      </div>
    </section>
  );
}
