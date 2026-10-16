"use client";

import { AnimatePresence, m } from "framer-motion";
import { MotionProvider } from "@/components/motion/motion-provider";
import { useReducedMotion } from "@/components/motion/use-reduced-motion";

export interface Banner {
  key: string;
  node: React.ReactNode;
}

/** More than this and the stack hides the transcripts; banners arrive most important first. */
const MAX_VISIBLE = 3;

/**
 * Room notices. On small screens they sit in the flow above the transcripts so they never cover
 * the latest turn; from `md` up they float over the top of the transcripts without moving the layout.
 */
export function BannerStack({ items }: { items: Banner[] }) {
  const reduced = useReducedMotion();
  const visible = items.slice(0, MAX_VISIBLE);
  return (
    <MotionProvider>
      <div className="relative z-20 flex flex-col gap-2 empty:hidden max-md:mb-4 md:pointer-events-none md:absolute md:inset-x-0 md:top-0 md:p-3">
        <AnimatePresence initial={false}>
          {visible.map(({ key, node }) => (
            <m.div
              key={key}
              initial={reduced ? false : { opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduced ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: -6 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
              className="pointer-events-auto rounded-lg bg-background/90 shadow-lg shadow-black/40 backdrop-blur-md [&>*]:mt-0 [&>*+*]:mt-2"
            >
              {node}
            </m.div>
          ))}
        </AnimatePresence>
      </div>
    </MotionProvider>
  );
}
