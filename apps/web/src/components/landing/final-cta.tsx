import { ScrollReveal } from "@/components/motion/scroll-reveal";
import { AuthCta } from "./auth-cta";

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
          className="mt-5 font-display text-3xl font-semibold tracking-[-0.03em] text-balance sm:text-4xl lg:leading-[1.1]"
        >
          Your code. Your interview.
        </h2>
        <p className="mx-auto mt-6 max-w-xl text-base leading-relaxed text-pretty text-muted-foreground sm:text-lg">
          Connect a repository and find out how well you can explain what you built, before
          someone else asks.
        </p>
        <AuthCta location="final-cta" size="lg" className="mt-10 h-12 px-6 text-[15px]" />
      </ScrollReveal>
    </section>
  );
}
