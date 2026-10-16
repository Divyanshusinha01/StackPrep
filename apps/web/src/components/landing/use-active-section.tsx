"use client";

import { createContext, useContext, useEffect, useState } from "react";

import { SECTIONS } from "./constants";

const ActiveSectionContext = createContext<string | null>(null);

/** One observer for the whole landing page, shared by the header nav and the scroll spine. */
export function ActiveSectionProvider({ children }: { children: React.ReactNode }) {
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

  return <ActiveSectionContext.Provider value={active}>{children}</ActiveSectionContext.Provider>;
}

export function useActiveSection() {
  return useContext(ActiveSectionContext);
}
