"use client";

import { useMediaQuery } from "./use-media-query";

/**
 * Reports `false` during SSR and hydration, then the real preference, so server and
 * client markup match. Framer's own hook reads the media query on the first client
 * render and causes hydration mismatches for reduced-motion users.
 */
export function useReducedMotion(): boolean {
  return useMediaQuery("(prefers-reduced-motion: reduce)", false);
}
