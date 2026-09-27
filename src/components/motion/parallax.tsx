"use client";

import { useRef } from "react";
import {
  m,
  useScroll,
  useTransform,
  type MotionValue,
} from "framer-motion";

import { cn } from "@/lib/utils";
import { useIsDesktop } from "./use-media-query";
import { useReducedMotion } from "./use-reduced-motion";

const MOBILE_AMPLITUDE = 0.35;

/**
 * Maps a section's scroll progress (0 → 1) to a pixel offset travelling from
 * `+distance` to `-distance`. Larger distances read as closer depth planes.
 * Amplitude is reduced below `lg` and zeroed for reduced-motion users.
 */
export function useParallax(
  progress: MotionValue<number>,
  distance: number,
  inputRange: [number, number] = [0, 1],
): MotionValue<number> {
  const reduced = useReducedMotion();
  const isDesktop = useIsDesktop();
  const amplitude = reduced ? 0 : isDesktop ? distance : distance * MOBILE_AMPLITUDE;
  return useTransform(progress, inputRange, [amplitude, -amplitude]);
}

type ParallaxProps = {
  children: React.ReactNode;
  className?: string;
  /** Pixels travelled either side of rest while the element crosses the viewport. */
  distance?: number;
  axis?: "x" | "y";
};

export function Parallax({
  children,
  className,
  distance = 40,
  axis = "y",
}: ParallaxProps) {
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start end", "end start"],
  });
  const value = useParallax(scrollYProgress, distance);

  return (
    <m.div
      ref={ref}
      className={cn("will-change-transform", className)}
      style={axis === "y" ? { y: value } : { x: value }}
    >
      {children}
    </m.div>
  );
}
