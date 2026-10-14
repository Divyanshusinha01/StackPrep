"use client";

import { useEffect, useRef, useState } from "react";
import { m, useScroll, useSpring } from "framer-motion";
import { Menu, X } from "lucide-react";
import { Dialog } from "radix-ui";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useReducedMotion } from "@/components/motion/use-reduced-motion";
import { AuthCta } from "./auth-cta";
import { SECTIONS } from "./constants";
import { useActiveSection } from "./use-active-section";
import { Wordmark } from "./wordmark";

export { Wordmark } from "./wordmark";

function MobileMenu({ active }: { active: string | null }) {
  const [open, setOpen] = useState(false);
  const pendingTarget = useRef<string | null>(null);
  const reduced = useReducedMotion();

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <Button variant="ghost" size="icon-lg" className="md:hidden" aria-label="Open menu">
          <Menu aria-hidden />
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-background/70 backdrop-blur-sm md:hidden" />
        <Dialog.Content
          className="fixed inset-x-0 top-0 z-[80] border-b bg-panel px-6 pt-3 pb-6 shadow-2xl outline-none md:hidden"
          aria-describedby={undefined}
          onCloseAutoFocus={() => {
            const id = pendingTarget.current;
            pendingTarget.current = null;
            if (!id) return;
            // Scroll once the dialog has released its scroll lock; focus returns to the menu button.
            setTimeout(() => {
              document.getElementById(id)?.scrollIntoView({ behavior: reduced ? "auto" : "smooth" });
              history.replaceState(null, "", `#${id}`);
            }, 0);
          }}
        >
          <div className="flex h-10 items-center justify-between">
            <Dialog.Title asChild>
              <span>
                <Wordmark />
                <span className="sr-only"> menu</span>
              </span>
            </Dialog.Title>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon-lg" aria-label="Close menu">
                <X aria-hidden />
              </Button>
            </Dialog.Close>
          </div>
          <nav aria-label="Sections" className="mt-4">
            <ul className="flex flex-col">
              {SECTIONS.map(({ id, step, label }) => (
                <li key={id}>
                  <a
                    href={`#${id}`}
                    aria-current={active === id ? "location" : undefined}
                    onClick={(event) => {
                      event.preventDefault();
                      pendingTarget.current = id;
                      setOpen(false);
                    }}
                    className={cn(
                      "focus-ring flex min-h-11 items-center gap-3 rounded-md px-2 text-base transition-colors",
                      active === id ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <span className={cn("font-mono text-xs", active === id ? "text-brand" : "text-muted-foreground/70")}>
                      {step}
                    </span>
                    {label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          <AuthCta location="mobile-menu" size="lg" className="mt-5 h-11 w-full text-[15px]" />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function SiteHeader() {
  const [scrolled, setScrolled] = useState(false);
  const active = useActiveSection();
  const reduced = useReducedMotion();
  const { scrollYProgress } = useScroll();
  const progress = useSpring(scrollYProgress, { stiffness: 200, damping: 40, restDelta: 0.001 });
  const interviewLive = active === "interview";

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
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-4 sm:px-6 md:gap-6">
        <a
          href="#top"
          className="rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          aria-label="StackPrep home"
        >
          <span className="inline-flex items-center gap-2">
            <Wordmark />
            {interviewLive ? (
              <span
                className="relative flex size-4 items-center justify-center"
                aria-hidden
                title="Interview section"
              >
                <span className="absolute inset-0 rounded-full border border-brand/60 motion-safe:animate-ping" />
                <span className="size-2 rounded-full bg-brand" />
              </span>
            ) : null}
          </span>
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
                      "flex items-center gap-1.5 rounded-md border-b-2 px-2.5 py-1.5 text-[13px] outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50",
                      current
                        ? "border-brand text-foreground"
                        : "border-transparent text-muted-foreground hover:border-brand/30 hover:text-foreground",
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

        <AuthCta
          location="site-header"
          size="sm"
          className="ml-auto h-10 max-[380px]:px-2.5 md:ml-0 md:h-8"
          iconClassName="size-3.5"
        />
        <MobileMenu active={active} />
      </div>

      <m.div
        aria-hidden
        className="absolute inset-x-0 -bottom-px h-0.5 origin-left bg-linear-to-r from-brand to-success"
        style={{ scaleX: reduced ? scrollYProgress : progress }}
      />
    </header>
  );
}
