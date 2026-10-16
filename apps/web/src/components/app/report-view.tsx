import {
  type InterviewReport,
  isLearningReport,
  type LearningReport,
  type ReportRating,
  type StoredInterviewReport,
} from "@stackprep/shared";
import { type ChipTone, StatusChip } from "@/components/app/status-chip";
import { SurfaceList } from "@/components/app/surface";
import { AssessmentChip } from "./report-view/assessment-chip";
import { Bullets } from "./report-view/bullets";
import { ConceptCard } from "./report-view/concept-card";
import { InterviewEvidenceList, RepositoryEvidenceList } from "./report-view/evidence-list";
import { LearningPlan } from "./report-view/learning-plan";
import { QuestionReview, questionAnchor } from "./report-view/question-review";
import { ReportText } from "./report-view/report-text";
import { ReviewDisclosure } from "./report-view/review-disclosure";
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

type TocItem = { readonly id: string; readonly label: string };

/** Sections of reports generated before learning reports, in their original order. */
export const REPORT_SECTIONS = [
  { id: "report-summary", label: "Executive summary" },
  { id: "report-categories", label: "Category evaluation" },
  { id: "report-strengths", label: "Strengths" },
  { id: "report-gaps", label: "Weaknesses and knowledge gaps" },
  { id: "report-interview-evidence", label: "Evidence from the interview" },
  { id: "report-repository-evidence", label: "Evidence from the repository" },
  { id: "report-improve", label: "Areas to improve" },
] as const satisfies readonly TocItem[];

/** Sections of a learning report in PRD order. */
export const LEARNING_REPORT_SECTIONS = [
  { id: "report-summary", label: "Executive summary" },
  { id: "report-performance", label: "Performance breakdown" },
  { id: "report-questions", label: "Question-by-question review" },
  { id: "report-concepts", label: "Concepts to learn" },
  { id: "report-examples", label: "Improved answer examples" },
  { id: "report-plan", label: "Prioritized learning plan" },
  { id: "report-recommendations", label: "Final recommendations" },
  { id: "report-evidence", label: "Evidence" },
] as const satisfies readonly TocItem[];

/** Table-of-contents entries for a stored report; the page adds the transcript last. */
export function reportSections(report: StoredInterviewReport): readonly TocItem[] {
  return isLearningReport(report) ? LEARNING_REPORT_SECTIONS : REPORT_SECTIONS;
}

function Section({ item, children }: { item: TocItem; children: React.ReactNode }) {
  return (
    <section
      id={item.id}
      className="scroll-mt-[calc(var(--app-header-h)+1.5rem)] border-t border-border/70 pt-8 first:border-t-0 first:pt-0 print:break-inside-avoid-page"
      aria-labelledby={`${item.id}-title`}
    >
      <h2 id={`${item.id}-title`} className="font-display text-lg font-semibold tracking-tight">
        {item.label}
      </h2>
      {children}
    </section>
  );
}

function SubHeading({ children }: { children: React.ReactNode }) {
  return <h3 className="mt-6 font-display text-sm font-semibold">{children}</h3>;
}

function section<T extends readonly TocItem[]>(items: T, id: T[number]["id"]): TocItem {
  return items.find((s) => s.id === id)!;
}

function Summary({ text }: { text: string }) {
  return (
    <div className="mt-4 border-l-2 border-brand/50 pl-5 print:border-border">
      <p className="max-w-3xl text-[15px] leading-relaxed whitespace-pre-wrap text-foreground/95">{text}</p>
    </div>
  );
}

function Categories({ categories }: { categories: InterviewReport["categories"] }) {
  return (
    <SurfaceList className="mt-4 bg-panel/50">
      {categories.map((category, i) => (
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
  );
}

/**
 * The report sections in PRD order (the transcript is rendered by the page). There is no overall
 * score; ratings are qualitative per category and per answer.
 */
export function ReportView({ report }: { report: StoredInterviewReport }) {
  return isLearningReport(report) ? <LearningReportView report={report} /> : <LegacyReportView report={report} />;
}

function LearningReportView({ report }: { report: LearningReport }) {
  const s = (id: (typeof LEARNING_REPORT_SECTIONS)[number]["id"]) => section(LEARNING_REPORT_SECTIONS, id);
  const conceptNames = new Map(report.concepts.map((c) => [c.id, c.name]));
  const numbers = new Map(report.question_reviews.map((r, i) => [r.question_message_id, i + 1]));
  const firstToOpen = report.question_reviews.findIndex((r) => r.assessment !== "correct");
  const examples = report.question_reviews.filter((r) => r.ideal_answer.trim() !== "");
  const recommendations = report.final_recommendations.length > 0 ? report.final_recommendations : report.areas_to_improve;

  return (
    <div data-testid="interview-report" data-report-version="2" className="space-y-10">
      <Section item={s("report-summary")}>
        <Summary text={report.executive_summary} />
      </Section>

      <Section item={s("report-performance")}>
        <SubHeading>By category</SubHeading>
        <Categories categories={report.categories} />
        <SubHeading>Strengths</SubHeading>
        <Bullets items={report.strengths} empty="No clear strengths were identified in this interview." variant="success" />
        <SubHeading>Weaknesses and knowledge gaps</SubHeading>
        <Bullets items={report.gaps} empty="No significant gaps were identified." variant="warning" />
      </Section>

      <Section item={s("report-questions")}>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">
          Your answers are quoted from the transcript. Expected answers and feedback are AI-generated
          references; accept them as guidance, not as the only correct answer. The verdict on each
          answer comes from the evaluation made during the interview.
        </p>
        {report.question_reviews.length === 0 ? (
          <p className="mt-4 text-sm text-muted-foreground">No evaluated questions were available to review.</p>
        ) : (
          <ol className="mt-4 space-y-3">
            {report.question_reviews.map((review, i) => (
              <li key={review.question_message_id}>
                <QuestionReview
                  review={review}
                  number={i + 1}
                  conceptNames={conceptNames}
                  defaultOpen={i === firstToOpen}
                />
              </li>
            ))}
          </ol>
        )}
      </Section>

      <Section item={s("report-concepts")}>
        {report.concepts.length === 0 ? (
          <p className="mt-2.5 text-sm text-muted-foreground">No specific concepts to study were identified.</p>
        ) : (
          <div className="mt-4 grid gap-4 xl:grid-cols-2">
            {report.concepts.map((concept) => (
              <ConceptCard
                key={concept.id}
                concept={concept}
                questions={concept.question_ids.flatMap((id) => {
                  const number = numbers.get(id);
                  return number ? [{ anchor: questionAnchor({ question_message_id: id }), number }] : [];
                })}
              />
            ))}
          </div>
        )}
      </Section>

      <Section item={s("report-examples")}>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">
          AI-generated examples of a strong answer to each question. Other correct approaches exist.
        </p>
        {examples.length === 0 ? (
          <p className="mt-4 text-sm text-muted-foreground">No example answers were produced.</p>
        ) : (
          <ol className="mt-4 space-y-3">
            {examples.map((review) => {
              const number = numbers.get(review.question_message_id)!;
              return (
                <li key={review.question_message_id}>
                  <ReviewDisclosure
                    id={`example-${review.question_message_id}`}
                    defaultOpen={review.assessment === "incorrect" || review.assessment === "unanswered"}
                    summary={
                      <>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
                            Question {number}
                          </span>
                          <AssessmentChip assessment={review.assessment} />
                        </div>
                        <p className="mt-2 text-sm leading-relaxed font-medium break-words text-foreground">
                          {review.question}
                        </p>
                      </>
                    }
                  >
                    <ReportText text={review.ideal_answer} />
                    <a
                      href={`#${questionAnchor(review)}`}
                      className="focus-ring mt-3 inline-block rounded text-xs text-muted-foreground underline-offset-2 hover:underline"
                    >
                      Back to the review of question {number}
                    </a>
                  </ReviewDisclosure>
                </li>
              );
            })}
          </ol>
        )}
      </Section>

      <Section item={s("report-plan")}>
        <LearningPlan items={report.learning_plan} conceptNames={conceptNames} />
      </Section>

      <Section item={s("report-recommendations")}>
        <Bullets items={recommendations} empty="No further recommendations." variant="brand" />
      </Section>

      <Section item={s("report-evidence")}>
        <SubHeading>From the interview</SubHeading>
        <InterviewEvidenceList items={report.interview_evidence} />
        <SubHeading>From the repository</SubHeading>
        <RepositoryEvidenceList items={report.repository_evidence} />
      </Section>
    </div>
  );
}

function LegacyReportView({ report }: { report: InterviewReport }) {
  const s = (id: (typeof REPORT_SECTIONS)[number]["id"]) => section(REPORT_SECTIONS, id);
  return (
    <div data-testid="interview-report" className="space-y-10">
      <Section item={s("report-summary")}>
        <Summary text={report.executive_summary} />
      </Section>

      <Section item={s("report-categories")}>
        <Categories categories={report.categories} />
      </Section>

      <Section item={s("report-strengths")}>
        <Bullets
          items={report.strengths}
          empty="No clear strengths were identified in this interview."
          variant="success"
        />
      </Section>

      <Section item={s("report-gaps")}>
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

      <Section item={s("report-interview-evidence")}>
        <InterviewEvidenceList items={report.interview_evidence} />
      </Section>

      <Section item={s("report-repository-evidence")}>
        <RepositoryEvidenceList items={report.repository_evidence} />
      </Section>

      <Section item={s("report-improve")}>
        <Bullets
          items={report.areas_to_improve}
          empty="No specific areas to improve were identified."
          variant="brand"
        />
      </Section>
    </div>
  );
}
