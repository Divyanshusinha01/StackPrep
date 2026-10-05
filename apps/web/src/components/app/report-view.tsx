import type { InterviewReport, ReportRating } from "@stackprep/shared";
import { cn } from "@/lib/utils";

const RATING_LABELS: Record<ReportRating, string> = {
  strong: "Strong",
  proficient: "Proficient",
  developing: "Developing",
  weak: "Needs work",
  insufficient_evidence: "Not enough evidence",
};

function RatingBadge({ rating }: { rating: ReportRating }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs",
        rating === "strong" && "border-emerald-500/30 text-emerald-300",
        rating === "proficient" && "border-sky-500/30 text-sky-300",
        rating === "developing" && "border-amber-500/30 text-amber-300",
        rating === "weak" && "border-red-500/30 text-red-300",
        rating === "insufficient_evidence" && "border-border text-muted-foreground",
      )}
    >
      {RATING_LABELS[rating]}
    </span>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section className="mt-10" aria-labelledby={id}>
      <h2 id={id} className="font-display text-lg font-semibold">
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
    <ul className="mt-3 list-disc space-y-1.5 pl-5 text-sm leading-relaxed">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}

/**
 * The report sections in PRD order (the transcript is rendered by the page). There is no overall
 * score; ratings are qualitative per category.
 */
export function ReportView({ report }: { report: InterviewReport }) {
  return (
    <div data-testid="interview-report">
      <Section id="report-summary" title="Executive summary">
        <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed">{report.executive_summary}</p>
      </Section>

      <Section id="report-categories" title="Category evaluation">
        <ul className="mt-4 divide-y rounded-lg border bg-panel/60">
          {report.categories.map((category, i) => (
            <li key={i} className="px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-medium">{category.name}</h3>
                <RatingBadge rating={category.rating} />
              </div>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{category.narrative}</p>
            </li>
          ))}
        </ul>
      </Section>

      <Section id="report-strengths" title="Strengths">
        <Bullets items={report.strengths} empty="No clear strengths were identified in this interview." />
      </Section>

      <Section id="report-gaps" title="Weaknesses and knowledge gaps">
        <Bullets items={report.gaps} empty="No significant gaps were identified." />
        {report.struggled_questions.length > 0 ? (
          <div className="mt-6">
            <h3 className="text-sm font-medium">Questions to revisit</h3>
            <ul className="mt-3 space-y-3">
              {report.struggled_questions.map((q, i) => (
                <li key={i} className="rounded-lg border bg-panel/60 px-4 py-3 text-sm">
                  <p className="font-medium">{q.question}</p>
                  <dl className="mt-2 grid gap-x-4 gap-y-1.5 text-muted-foreground sm:grid-cols-[10rem_1fr]">
                    <dt className="text-xs uppercase tracking-wide">Your answer</dt>
                    <dd>{q.performance}</dd>
                    <dt className="text-xs uppercase tracking-wide">Weakness</dt>
                    <dd>{q.weakness}</dd>
                    <dt className="text-xs uppercase tracking-wide">Repository area</dt>
                    <dd className="font-mono text-xs leading-5">{q.repository_area}</dd>
                    <dt className="text-xs uppercase tracking-wide">What to study</dt>
                    <dd>{q.learning_direction}</dd>
                  </dl>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Section>

      <Section id="report-interview-evidence" title="Evidence from the interview">
        {report.interview_evidence.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">No interview evidence was recorded.</p>
        ) : (
          <ul className="mt-3 space-y-2 text-sm">
            {report.interview_evidence.map((item, i) => (
              <li key={i}>
                <span className="text-muted-foreground">{item.category}:</span> {item.observation}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section id="report-repository-evidence" title="Evidence from the repository">
        {report.repository_evidence.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">No repository files were referenced.</p>
        ) : (
          <ul className="mt-3 space-y-2 text-sm">
            {report.repository_evidence.map((item, i) => (
              <li key={i}>
                <span className="font-mono text-xs">{item.path}</span>
                <span className="text-muted-foreground"> — {item.note}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section id="report-improve" title="Areas to improve">
        <Bullets items={report.areas_to_improve} empty="No specific areas to improve were identified." />
      </Section>
    </div>
  );
}
