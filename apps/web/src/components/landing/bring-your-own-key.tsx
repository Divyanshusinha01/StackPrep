import { ExternalLink, FileSearch, GitBranch, KeyRound, Lock, Mic, ReceiptText, ShieldCheck, Sparkles } from "lucide-react";

import { ScrollReveal } from "@/components/motion/scroll-reveal";
import { Eyebrow } from "@/components/ui/eyebrow";
import { PILL_CLASS } from "./pill";
import { SectionHeading } from "./section-heading";

const YOU_PROVIDE = [
  { icon: KeyRound, title: "Your OpenAI API key", body: "Added once, right after you sign in. It serves every workspace on your account." },
  { icon: ReceiptText, title: "Your OpenAI bill", body: "AI usage is billed by OpenAI directly to your account, at OpenAI's rates." },
];

const STACKPREP_RUNS = [
  { icon: Mic, title: "Interview infrastructure and realtime voice" },
  { icon: GitBranch, title: "GitHub integration and repository analysis" },
  { icon: FileSearch, title: "Answer evaluation, grounded in your files" },
  { icon: Sparkles, title: "Written reports after every interview" },
];

const TRUST = [
  "Validated with OpenAI before it is stored",
  "Encrypted at rest, used only server-side",
  "Only the last four characters are ever shown",
  "Replace or delete it any time",
];

export function BringYourOwnKey() {
  return (
    <section id="your-key" aria-labelledby="your-key-heading" className="relative scroll-mt-20 border-t py-24 sm:py-32">
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-dots mask-fade-y opacity-60" />
      <div className="relative mx-auto max-w-6xl px-6">
        <ScrollReveal>
          <SectionHeading id="your-key-heading" eyebrow="06 — Your key" title="Your key. Your usage." align="center">
            StackPrep runs on your own OpenAI API key. You pay OpenAI directly for the AI it uses; StackPrep runs
            everything around it.
          </SectionHeading>
        </ScrollReveal>

        <div className="mt-14 grid grid-cols-1 gap-6 lg:grid-cols-2">
          <ScrollReveal className="h-full">
            <div className="surface-inset h-full rounded-xl border bg-panel/60 p-6">
              <Eyebrow tone="muted">You provide</Eyebrow>
              <ul className="mt-5 space-y-5">
                {YOU_PROVIDE.map(({ icon: Icon, title, body }) => (
                  <li key={title} className="flex items-start gap-3.5">
                    <span
                      aria-hidden
                      className="grid size-9 shrink-0 place-items-center rounded-lg border border-brand/30 bg-brand-muted text-brand"
                    >
                      <Icon className="size-4" />
                    </span>
                    <span>
                      <span className="block font-display text-base font-medium text-foreground">{title}</span>
                      <span className="mt-1 block text-sm leading-relaxed text-muted-foreground">{body}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </ScrollReveal>

          <ScrollReveal delay={0.08} className="h-full">
            <div className="surface-inset h-full rounded-xl border border-brand/25 bg-linear-to-br from-panel-raised/90 via-panel/80 to-panel/60 p-6">
              <Eyebrow>StackPrep runs</Eyebrow>
              <ul className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
                {STACKPREP_RUNS.map(({ icon: Icon, title }) => (
                  <li key={title} className="flex items-start gap-3 rounded-lg border bg-background/40 px-3.5 py-3 text-sm">
                    <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-brand" />
                    <span className="text-foreground/90">{title}</span>
                  </li>
                ))}
              </ul>
            </div>
          </ScrollReveal>
        </div>

        <ScrollReveal delay={0.12}>
          <ul className="mt-6 flex flex-wrap justify-center gap-2">
            {TRUST.map((item, i) => (
              <li key={item} className={PILL_CLASS}>
                {i < 2 ? (
                  <ShieldCheck aria-hidden className="size-3.5 text-brand" />
                ) : (
                  <Lock aria-hidden className="size-3.5 text-brand" />
                )}
                {item}
              </li>
            ))}
          </ul>
          <p className="mx-auto mt-6 max-w-2xl text-center text-sm leading-relaxed text-pretty text-muted-foreground">
            StackPrep never funds, marks up, or falls back to another key for your AI usage. It appears on your OpenAI
            bill, where you can set your own spend limits.{" "}
            <a
              href="https://platform.openai.com/settings/organization/billing/overview"
              target="_blank"
              rel="noreferrer"
              className="focus-ring inline-flex items-center gap-1 rounded-sm text-brand hover:underline"
            >
              OpenAI billing
              <ExternalLink className="size-3.5" aria-hidden />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          </p>
        </ScrollReveal>
      </div>
    </section>
  );
}
