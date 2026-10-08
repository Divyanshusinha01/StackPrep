import { BookOpen, FileCode2, MessageSquareQuote, Target } from "lucide-react";
import type { InterviewReport, ReportRating } from "@stackprep/shared";
import { type ChipTone, StatusChip } from "@/components/app/status-chip";

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
      className="scroll-mt-[calc(var(--app-header-h)+1.5rem)] border-t pt-8 first:border-t-0 first:pt-0 print:break-inside-avoid-page"
      aria-labelledby={`${id}-title`}
    >
      <h2 id={`${id}-title`} className="font-display text-lg font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Bullets({ items, empty }: { items: string[]; empty: string }) {
  if (items.length === 0) {
    return <p className="mt-2 text-sm text-muted-foreground">{empty}</p>;
  }
  return (
    <ul className="mt-3 list-disc space-y-1.5 pl-5 text-sm leading-relaxed marker:text-brand">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}

function RevisitField({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {icon}
        {label}
      </dt>
      <dd className="mt-1 leading-relaxed">{children}</dd>
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
        <p className="mt-3 text-[15px] leading-relaxed whitespace-pre-wrap">{report.executive_summary}</p>
      </Section>

      <Section id="report-categories">
        <ul className="mt-4 grid gap-3 sm:grid-cols-2">
          {report.categories.map((category, i) => (
            <li key={i} className="flex flex-col rounded-xl border bg-panel/60 p-4 print:break-inside-avoid">
              <div className="flex items-start justify-between gap-3">
                <h3 className="text-sm font-medium">{category.name}</h3>
                <StatusChip tone={RATING_TONES[category.rating]}>{RATING_LABELS[category.rating]}</StatusChip>
              </div>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{category.narrative}</p>
            </li>
          ))}
        </ul>
      </Section>

      <Section id="report-strengths">
        <Bullets items={report.strengths} empty="No clear strengths were identified in this interview." />
      </Section>

      <Section id="report-gaps">
        <Bullets items={report.gaps} empty="No significant gaps were identified." />
        {report.struggled_questions.length > 0 ? (
          <div className="mt-8">
            <h3 className="text-sm font-medium">Questions to revisit</h3>
            <ul className="mt-3 space-y-3">
              {report.struggled_questions.map((q, i) => (
                <li key={i} className="rounded-xl border bg-panel/60 p-4 text-sm print:break-inside-avoid">
                  <code className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-brand/20 bg-brand-muted px-2 py-0.5 font-mono text-xs break-all text-brand">
                    <FileCode2 className="size-3.5 shrink-0" aria-hidden />
                    <span className="sr-only">Repository area: </span>
                    {q.repository_area}
                  </code>
                  <p className="mt-3 font-medium leading-relaxed">{q.question}</p>
                  <dl className="mt-4 grid gap-4 sm:grid-cols-2">
                    <RevisitField icon={<MessageSquareQuote className="size-3.5" aria-hidden />} label="Your answer">
                      {q.performance}
                    </RevisitField>
                    <RevisitField icon={<Target className="size-3.5" aria-hidden />} label="Weakness">
                      {q.weakness}
                    </RevisitField>
                    <div className="sm:col-span-2">
                      <RevisitField icon={<BookOpen className="size-3.5" aria-hidden />} label="What to study">
                        {q.learning_direction}
                      </RevisitField>
                    </div>
                  </dl>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Section>

      <Section id="report-interview-evidence">
        {report.interview_evidence.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">No interview evidence was recorded.</p>
        ) : (
          <ul className="mt-3 space-y-2.5 text-sm leading-relaxed">
            {report.interview_evidence.map((item, i) => (
              <li key={i} className="flex flex-col gap-1 sm:flex-row sm:gap-3">
                <span className="shrink-0 text-xs font-medium text-muted-foreground sm:w-40 sm:pt-0.5">{item.category}</span>
                <span>{item.observation}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section id="report-repository-evidence">
        {report.repository_evidence.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">No repository files were referenced.</p>
        ) : (
          <ul className="mt-3 space-y-2.5 text-sm leading-relaxed">
            {report.repository_evidence.map((item, i) => (
              <li key={i}>
                <code className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-xs break-all">{item.path}</code>
                <span className="text-muted-foreground"> — {item.note}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section id="report-improve">
        <Bullets items={report.areas_to_improve} empty="No specific areas to improve were identified." />
      </Section>
    </div>
  );
}
