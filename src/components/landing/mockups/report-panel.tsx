import { ArrowRight, Check, Compass } from "lucide-react";

import { FileChip, Panel } from "./panel";

const CATEGORIES = [
  {
    name: "Architecture",
    note: "Explained the API → service → data flow clearly and without prompting.",
    evidence: "src/api/",
  },
  {
    name: "Technical decisions",
    note: "Justified server-side sessions with a concrete revocation requirement.",
    evidence: "src/auth/session.ts",
  },
  {
    name: "Problem-solving",
    note: "Reached webhook idempotency after one follow-up; reasoning was sound.",
    evidence: "src/lib/queue.ts",
  },
];

const STRENGTHS = [
  "Clear mental model of the request lifecycle",
  "Decisions tied to real product constraints",
];

const AREAS = [
  {
    title: "Concurrent retries in queue workers",
    direction: "Revisit how duplicate jobs are detected when two workers race.",
  },
  {
    title: "Testing strategy for webhooks",
    direction: "Consider how failure paths are covered end to end.",
  },
];

export function ReportPanel({ className, glow }: { className?: string; glow?: boolean }) {
  return (
    <Panel
      className={className}
      glow={glow}
      title="Interview 3 · Report"
      meta={<span>acme/checkout-service</span>}
      bodyClassName="space-y-5 p-4 sm:p-5"
    >
      <div>
        <p className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
          Executive summary
        </p>
        <p className="mt-2 text-sm leading-relaxed text-foreground/90">
          Strong command of the request lifecycle and auth design. Reasoning about failure
          handling in async jobs was less certain and is the clearest area to explore next.
        </p>
      </div>

      <div>
        <p className="mb-2 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
          Category evaluation
        </p>
        <ul className="divide-y rounded-lg border">
          {CATEGORIES.map((c) => (
            <li key={c.name} className="grid gap-1.5 p-3 sm:grid-cols-[9rem_1fr] sm:gap-4">
              <span className="text-sm font-medium text-foreground">{c.name}</span>
              <span className="space-y-1.5">
                <span className="block text-sm text-foreground/75">{c.note}</span>
                <FileChip>{c.evidence}</FileChip>
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <p className="mb-2 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
            Strengths
          </p>
          <ul className="space-y-2">
            {STRENGTHS.map((s) => (
              <li key={s} className="flex gap-2 text-sm text-foreground/85">
                <Check className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden />
                {s}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p className="mb-2 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
            Areas to improve
          </p>
          <ul className="space-y-2.5">
            {AREAS.map((a) => (
              <li key={a.title} className="flex gap-2 text-sm">
                <Compass className="mt-0.5 size-3.5 shrink-0 text-brand" aria-hidden />
                <span>
                  <span className="block text-foreground/85">{a.title}</span>
                  <span className="block text-xs text-muted-foreground">{a.direction}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="flex items-center justify-between border-t pt-4 text-xs text-muted-foreground">
        <span>No overall score · no ranking</span>
        <span className="inline-flex items-center gap-1 text-foreground/80">
          Full transcript
          <ArrowRight className="size-3" aria-hidden />
        </span>
      </div>
    </Panel>
  );
}
