import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ScrollReveal } from "@/components/motion/scroll-reveal";
import { CONNECT_GITHUB_HREF, CTA_GLOW } from "./constants";
import { GitHubMark } from "./github-mark";

export function FinalCta() {
  return (
    <section aria-labelledby="cta-heading" className="relative overflow-hidden border-t py-28 sm:py-40">
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-grid mask-radial opacity-70" />
      <div
        aria-hidden
        className="glow-brand pointer-events-none absolute inset-x-0 top-1/2 mx-auto h-[36rem] w-[60rem] max-w-[160vw] -translate-y-1/2"
      />

      <ScrollReveal className="relative mx-auto max-w-3xl px-6 text-center">
        <p className="font-mono text-xs uppercase tracking-[0.18em] text-brand">Ready when you are</p>
        <h2
          id="cta-heading"
          className="mt-5 font-display text-4xl font-semibold tracking-[-0.04em] text-balance sm:text-6xl lg:leading-[1.05]"
        >
          Your code. <span className="text-gradient-brand">Your interview.</span>
        </h2>
        <p className="mx-auto mt-6 max-w-xl text-base leading-relaxed text-pretty text-muted-foreground sm:text-lg">
          Connect a repository and find out how well you can explain what you built, before
          someone else asks.
        </p>
        <Button
          asChild
          size="lg"
          className={cn("mt-10 h-12 px-6 text-[15px]", CTA_GLOW)}
        >
          <a href={CONNECT_GITHUB_HREF}>
            <GitHubMark className="size-4" />
            Connect GitHub
          </a>
        </Button>
      </ScrollReveal>
    </section>
  );
}
