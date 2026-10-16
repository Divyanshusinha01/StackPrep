"use client";

import { useRef } from "react";
import { m, useScroll, useTransform } from "framer-motion";

import { ScrollReveal } from "@/components/motion/scroll-reveal";
import { useIsDesktop } from "@/components/motion/use-media-query";
import { useReducedMotion } from "@/components/motion/use-reduced-motion";
import { InterviewPanel } from "./mockups/interview-panel";
import { ReportPanel } from "./mockups/report-panel";
import { SectionHeading } from "./section-heading";

export function InterviewReport() {
  const stageRef = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const isDesktop = useIsDesktop();
  const handoff = isDesktop && !reduced;

  const { scrollYProgress } = useScroll({
    target: stageRef,
    offset: ["start end", "center 0.55"],
  });

  // The finished interview recedes while its report comes forward.
  const interviewScale = useTransform(scrollYProgress, [0, 1], [1, 0.88]);
  const interviewY = useTransform(scrollYProgress, [0, 1], [40, -40]);
  const interviewOpacity = useTransform(scrollYProgress, [0.2, 1], [0.7, 0.12]);
  const reportScale = useTransform(scrollYProgress, [0, 1], [0.9, 1]);
  const reportY = useTransform(scrollYProgress, [0, 1], [140, 0]);
  const reportOpacity = useTransform(scrollYProgress, [0.1, 0.7], [0.3, 1]);

  return (
    <section
      id="report"
      aria-labelledby="report-heading"
      className="section-elevated relative scroll-mt-20 overflow-hidden border-t py-24 sm:py-32"
    >
      <div className="relative mx-auto max-w-6xl px-6">
        <ScrollReveal>
          <div className="grid gap-8 lg:grid-cols-2 lg:items-start lg:gap-12">
            <SectionHeading
              id="report-heading"
              eyebrow="05 — Report"
              title="A report built on evidence, not a score."
              align="left"
              className="max-w-none lg:max-w-xl"
            >
              Right after the interview, get a written evaluation of each area: strengths,
              knowledge gaps, and where to dig in next, tied back to your answers and your
              repository, generated with your OpenAI key. No overall score. No ranking.
            </SectionHeading>
            <blockquote className="border-l-2 border-brand/40 pl-5 text-base leading-relaxed text-pretty text-muted-foreground italic lg:mt-8 lg:text-lg">
              “Strong on the request lifecycle and auth design—the async failure paths are where
              the next interview should press.”
            </blockquote>
          </div>
        </ScrollReveal>

        <div ref={stageRef} className="relative mt-16 lg:mt-20">
          {handoff ? (
            <m.div
              aria-hidden
              inert
              className="pointer-events-none absolute top-0 left-1/2 w-[600px] -translate-x-1/2"
              style={{ scale: interviewScale, y: interviewY, opacity: interviewOpacity }}
            >
              <InterviewPanel />
            </m.div>
          ) : null}

          {handoff ? (
            <m.div
              className="relative z-10 mx-auto max-w-4xl lg:pt-24"
              style={{ scale: reportScale, y: reportY, opacity: reportOpacity }}
            >
              <ReportPanel glow />
            </m.div>
          ) : (
            <ScrollReveal variant="scale" className="mx-auto max-w-4xl">
              <ReportPanel glow />
            </ScrollReveal>
          )}
        </div>
      </div>
    </section>
  );
}
