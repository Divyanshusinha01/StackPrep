"use client";

import { LazyMotion, domAnimation } from "framer-motion";

/** Loads only the DOM animation features; components must use `m.*` instead of `motion.*`. */
export function MotionProvider({ children }: { children: React.ReactNode }) {
  return (
    <LazyMotion features={domAnimation} strict>
      {children}
    </LazyMotion>
  );
}
