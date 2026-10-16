import type { InterviewReport, ReportRating } from "@stackprep/shared";
import { type ChipTone, StatusChip } from "@/components/app/status-chip";
import { SurfaceList } from "@/components/app/surface";
import { Bullets } from "./report-view/bullets";
import { InterviewEvidenceList, RepositoryEvidenceList } from "./report-view/evidence-list";
import { RevisitQuestion } from "./report-view/revisit-question";

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
        <SurfaceList className="mt-4 bg-panel/50">
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
        </SurfaceList>
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
                <li key={i}>
                  <RevisitQuestion question={q} />
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Section>

      <Section id="report-interview-evidence">
        <InterviewEvidenceList items={report.interview_evidence} />
      </Section>

      <Section id="report-repository-evidence">
        <RepositoryEvidenceList items={report.repository_evidence} />
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
