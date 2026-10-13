import { ArrowUpRight, BookOpen, Check, FileCode2, MessageSquareQuote, Target } from "lucide-react";
import type { InterviewReport, ReportRating } from "@stackprep/shared";
import { type ChipTone, StatusChip } from "@/components/app/status-chip";
import { cn } from "@/lib/utils";

const RATING_LABELS: Record<ReportRating, string> = {
  strong: "Strong",
  proficient: "Proficient",
  developing: "Developing",
  weak: "Needs work",
  insufficient_evidence: "Not enough evidence",
};

const RATING_TONES: Record<ReportRating, ChipTone> = {
  strong: "success",
  proficient: "info",
  developing: "warning",
  weak: "danger",
  insufficient_evidence: "neutral",
};

/** Report sections in PRD order, for the table of contents; the page adds the transcript last. */
export const REPORT_SECTIONS = [
  { id: "report-summary", label: "Executive summary" },
  { id: "report-categories", label: "Category evaluation" },
  { id: "report-strengths", label: "Strengths" },
  { id: "report-gaps", label: "Weaknesses and knowledge gaps" },
  { id: "report-interview-evidence", label: "Evidence from the interview" },
  { id: "report-repository-evidence", label: "Evidence from the repository" },
  { id: "report-improve", label: "Areas to improve" },
] as const;

type SectionId = (typeof REPORT_SECTIONS)[number]["id"];

function Section({ id, children }: { id: SectionId; children: React.ReactNode }) {
  const title = REPORT_SECTIONS.find((s) => s.id === id)?.label;
  return (
    <section
      id={id}
      className="scroll-mt-[calc(var(--app-header-h)+1.5rem)] border-t border-border/70 pt-8 first:border-t-0 first:pt-0 print:break-inside-avoid-page"
      aria-labelledby={`${id}-title`}
    >
      <h2 id={`${id}-title`} className="font-display text-lg font-semibold tracking-tight">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Bullets({
  items,
  empty,
  variant = "brand",
}: {
  items: string[];
  empty: string;
  variant?: "success" | "warning" | "brand";
}) {
  if (items.length === 0) {
    return <p className="mt-2.5 text-sm text-muted-foreground">{empty}</p>;
  }
  return (
    <ul className="mt-3.5 space-y-2.5 text-sm leading-relaxed">
      {items.map((item, i) => (
        <li key={i} className="flex items-start gap-3">
          <span
            aria-hidden
            className={cn(
              "mt-1 grid size-4.5 shrink-0 place-items-center rounded-full border",
              variant === "success" && "border-emerald-500/35 bg-emerald-500/10 text-emerald-300",
              variant === "warning" && "border-amber-500/35 bg-amber-500/10 text-amber-300",
              variant === "brand" && "border-brand/35 bg-brand-muted text-brand",
            )}
          >
            {variant === "success" ? (
              <Check className="size-3" />
            ) : variant === "warning" ? (
              <Target className="size-3" />
            ) : (
              <ArrowUpRight className="size-3" />
            )}
          </span>
          <span className="min-w-0 flex-1 text-foreground/95">{item}</span>
        </li>
      ))}
    </ul>
  );
}

function RevisitField({
  icon,
  label,
  className,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("p-4", className)}>
      <dt className="flex items-center gap-1.5 font-mono text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
        {icon}
        {label}
      </dt>
      <dd className="mt-1.5 text-sm leading-relaxed text-foreground/90">{children}</dd>
    </div>
  );
}

/**
 * The report sections in PRD order (the transcript is rendered by the page). There is no overall
 * score; ratings are qualitative per category.
 */
export function ReportView({ report }: { report: InterviewReport }) {
  return (
    <div data-testid="interview-report" className="space-y-10">
      <Section id="report-summary">
        <div className="mt-4 border-l-2 border-brand/50 pl-5 print:border-border">
          <p className="max-w-3xl text-[15px] leading-relaxed whitespace-pre-wrap text-foreground/95">
            {report.executive_summary}
          </p>
        </div>
      </Section>

      <Section id="report-categories">
        <ul className="surface-inset mt-4 divide-y overflow-hidden rounded-xl border bg-panel/50">
          {report.categories.map((category, i) => (
            <li
              key={i}
              className="grid gap-3 p-4 sm:grid-cols-[13rem_minmax(0,1fr)] sm:items-start sm:gap-6 sm:p-5 print:break-inside-avoid"
            >
              <div className="flex flex-wrap items-center justify-between gap-2 sm:flex-col sm:items-start">
                <h3 className="font-display text-sm font-semibold text-foreground">{category.name}</h3>
                <StatusChip tone={RATING_TONES[category.rating]}>{RATING_LABELS[category.rating]}</StatusChip>
              </div>
              <p className="text-sm leading-relaxed text-muted-foreground">{category.narrative}</p>
            </li>
          ))}
        </ul>
      </Section>

      <Section id="report-strengths">
        <Bullets
          items={report.strengths}
          empty="No clear strengths were identified in this interview."
          variant="success"
        />
      </Section>

      <Section id="report-gaps">
        <Bullets items={report.gaps} empty="No significant gaps were identified." variant="warning" />
        {report.struggled_questions.length > 0 ? (
          <div className="mt-8">
            <h3 className="font-display text-sm font-semibold">Questions to revisit</h3>
            <ul className="mt-3.5 space-y-4">
              {report.struggled_questions.map((q, i) => (
                <li
                  key={i}
                  className="surface-inset overflow-hidden rounded-xl border bg-panel/60 text-sm print:break-inside-avoid"
                >
                  <div className="border-b bg-panel-raised/40 p-4">
                    <code className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-brand/30 bg-brand-muted/70 px-2 py-0.5 font-mono text-xs break-all text-brand">
                      <FileCode2 className="size-3.5 shrink-0" aria-hidden />
                      <span className="sr-only">Repository area: </span>
                      {q.repository_area}
                    </code>
                    <p className="mt-2.5 font-medium leading-relaxed text-foreground">{q.question}</p>
                  </div>
                  <dl className="divide-y sm:grid sm:grid-cols-2 sm:divide-y-0">
                    <RevisitField
                      icon={<MessageSquareQuote className="size-3.5 text-muted-foreground" aria-hidden />}
                      label="Your answer"
                      className="sm:border-r"
                    >
                      {q.performance}
                    </RevisitField>
                    <RevisitField
                      icon={<Target className="size-3.5 text-amber-300" aria-hidden />}
                      label="Weakness"
                    >
                      {q.weakness}
                    </RevisitField>
                    <RevisitField
                      icon={<BookOpen className="size-3.5 text-brand" aria-hidden />}
                      label="What to study"
                      className="bg-background/30 sm:col-span-2 sm:border-t"
                    >
                      {q.learning_direction}
                    </RevisitField>
                  </dl>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Section>

      <Section id="report-interview-evidence">
        {report.interview_evidence.length === 0 ? (
          <p className="mt-2.5 text-sm text-muted-foreground">No interview evidence was recorded.</p>
        ) : (
          <ul className="mt-3.5 divide-y divide-border/60 rounded-xl border bg-panel/40 px-4 text-sm leading-relaxed">
            {report.interview_evidence.map((item, i) => (
              <li key={i} className="flex flex-col gap-1 py-3 sm:flex-row sm:gap-4">
                <span className="shrink-0 font-mono text-xs font-medium text-muted-foreground sm:w-44 sm:pt-0.5">
                  {item.category}
                </span>
                <span className="text-foreground/95">{item.observation}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section id="report-repository-evidence">
        {report.repository_evidence.length === 0 ? (
          <p className="mt-2.5 text-sm text-muted-foreground">No repository files were referenced.</p>
        ) : (
          <ul className="mt-3.5 divide-y divide-border/60 rounded-xl border bg-panel/40 px-4 text-sm leading-relaxed">
            {report.repository_evidence.map((item, i) => (
              <li key={i} className="flex flex-col gap-1.5 py-3 sm:flex-row sm:items-baseline sm:gap-4">
                <span className="shrink-0 sm:w-60">
                  <code className="inline-block max-w-full rounded border border-border-strong/60 bg-background/60 px-2 py-0.5 font-mono text-xs break-all text-brand">
                    {item.path}
                  </code>
                </span>
                <span className="min-w-0 flex-1 text-muted-foreground">
                  <span className="sr-only"> — </span>
                  {item.note}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section id="report-improve">
        <Bullets
          items={report.areas_to_improve}
          empty="No specific areas to improve were identified."
          variant="brand"
        />
      </Section>
    </div>
  );
}
