"use client";

import { useRef, useState } from "react";
import { useMotionValueEvent, useScroll } from "framer-motion";
import { CornerDownRight, FileCode, Mic, Search, Waypoints } from "lucide-react";

import { Parallax } from "@/components/motion/parallax";
import { ScrollReveal } from "@/components/motion/scroll-reveal";
import { useReducedMotion } from "@/components/motion/use-reduced-motion";
import { INTERVIEW_MESSAGES, InterviewPanel } from "./mockups/interview-panel";
import { FileChip } from "./mockups/panel";
import { VoiceOrb } from "./mockups/voice-orb";
import { SectionHeading } from "./section-heading";
import { Spotlight } from "./spotlight";

const MINI_WAVE = [40, 75, 100, 60, 85, 45, 70, 95, 50, 65];

const FEATURES = [
  {
    icon: Mic,
    title: "Voice-first",
    body: "A natural 30-minute conversation, with live transcription of both sides.",
    visual: (
      <span className="flex h-7 items-center gap-[3px]">
        {MINI_WAVE.map((h, i) => (
          <span
            key={i}
            className="w-[3px] origin-center rounded-full bg-brand/70 motion-safe:animate-[wave_1.2s_ease-in-out_infinite]"
            style={{ height: `${h}%`, animationDelay: `${i * 90}ms` }}
          />
        ))}
      </span>
    ),
  },
  {
    icon: Search,
    title: "Grounded in evidence",
    body: "Each question points to the file, module, or area of the repository it’s about.",
    visual: (
      <FileChip>
        <FileCode className="size-3" />
        src/auth/session.ts
      </FileChip>
    ),
  },
  {
    icon: Waypoints,
    title: "Adaptive",
    body: "Follow-ups build on your previous answers instead of a fixed script.",
    visual: (
      <span className="flex flex-col gap-1 font-mono text-[11px] text-muted-foreground">
        <span>Why Postgres sessions?</span>
        <span className="flex items-center gap-1 text-brand">
          <CornerDownRight className="size-3" />
          And under concurrent logins?
        </span>
      </span>
    ),
  },
];

const LAST = INTERVIEW_MESSAGES.length - 1;

export function Interview() {
  const panelRef = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const [active, setActive] = useState(0);

  const { scrollYProgress } = useScroll({
    target: panelRef,
    offset: ["start 0.75", "end 0.6"],
  });

  useMotionValueEvent(scrollYProgress, "change", (value) => {
    setActive(Math.min(LAST, Math.floor(value * INTERVIEW_MESSAGES.length)));
  });

  const activeIndex = reduced ? LAST : active;

  return (
    <section
      id="interview"
      aria-labelledby="interview-heading"
      className="relative scroll-mt-20 overflow-hidden border-t py-24 sm:py-32"
    >
      <div
        aria-hidden
        className="glow-brand pointer-events-none absolute bottom-0 left-0 h-[36rem] w-[48rem] -translate-x-1/3 translate-y-1/4 opacity-60"
      />

      <div className="relative mx-auto max-w-6xl px-6">
        <ScrollReveal>
          <SectionHeading id="interview-heading" eyebrow="03 — Interview" title="An interviewer that has read your code.">
            The AI asks about your architecture, your decisions, and the code you shipped,
            then adapts to how you answer, the way a senior engineer would.
          </SectionHeading>
        </ScrollReveal>

        <ul className="mt-10 grid gap-4 sm:grid-cols-3">
          {FEATURES.map(({ icon: Icon, title, body, visual }, i) => (
            <li key={title}>
              <ScrollReveal delay={i * 0.08} className="h-full">
                <Spotlight className="flex h-full flex-col rounded-xl border bg-panel/60 p-5 transition-[translate,border-color] duration-300 hover:-translate-y-0.5 hover:border-brand/30">
                  <div aria-hidden className="flex h-12 items-center border-b border-dashed pb-4">
                    {visual}
                  </div>
                  <span className="mt-4 flex items-center gap-2 text-sm font-medium text-foreground">
                    <Icon className="size-4 text-brand" aria-hidden />
                    {title}
                  </span>
                  <span className="mt-1.5 block text-sm leading-relaxed text-muted-foreground">{body}</span>
                </Spotlight>
              </ScrollReveal>
            </li>
          ))}
        </ul>

        <div
          ref={panelRef}
          className="mt-14 grid grid-cols-1 items-center gap-8 lg:mt-16 lg:grid-cols-[14rem_1fr] lg:gap-12"
        >
          <VoiceOrb speaker={INTERVIEW_MESSAGES[activeIndex]?.role ?? "ai"} />
          <Parallax distance={24}>
            <InterviewPanel activeIndex={activeIndex} />
          </Parallax>
        </div>
      </div>
    </section>
  );
}
