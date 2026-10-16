import { ScrollReveal } from "@/components/motion/scroll-reveal";
import { AuthCta } from "./auth-cta";
import { SectionHeading } from "./section-heading";

export function FinalCta() {
  return (
    <section aria-labelledby="cta-heading" className="relative overflow-hidden border-t py-28 sm:py-40">
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-grid mask-radial opacity-70" />
      <div
        aria-hidden
        className="glow-brand pointer-events-none absolute inset-x-0 top-1/2 mx-auto h-[36rem] w-[60rem] max-w-[160vw] -translate-y-1/2"
      />

      <ScrollReveal className="relative mx-auto max-w-3xl px-6 text-center">
        <SectionHeading id="cta-heading" eyebrow="Ready when you are" title="Your code. Your interview." align="center">
          Connect a repository and find out how well you can explain what you built, before
          someone else asks.
        </SectionHeading>
        <AuthCta location="final-cta" size="lg" className="mt-10 h-11 px-6" />
        <p className="mt-4 text-sm text-muted-foreground">
          You&apos;ll add your OpenAI API key after signing in. AI usage is billed by OpenAI to your account.
        </p>
      </ScrollReveal>
    </section>
  );
}
