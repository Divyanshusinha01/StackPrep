import { FileCode2 } from "lucide-react";
import type { QuestionReview as QuestionReviewData } from "@stackprep/shared";
import { cn } from "@/lib/utils";
import { AssessmentChip } from "./assessment-chip";
import { ReportText } from "./report-text";
import { ReviewDisclosure } from "./review-disclosure";

export function questionAnchor(review: Pick<QuestionReviewData, "question_message_id">) {
  return `question-${review.question_message_id}`;
}

export function conceptAnchor(id: string) {
  return `concept-${id}`;
}

/** Labels where a block of the review came from, so AI-written text is never mistaken for a transcript. */
function SourceLabel({ title, source }: { title: string; source: string }) {
  return (
    <h4 className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <span className="font-display text-sm font-semibold text-foreground">{title}</span>
      <span className="font-mono text-[11px] tracking-wider text-muted-foreground uppercase">{source}</span>
    </h4>
  );
}

function IssueGroup({ title, items, tone }: { title: string; items: string[]; tone: "danger" | "warning" | "info" }) {
  if (items.length === 0) {
    return null;
  }
  return (
    <div>
      <p
        className={cn(
          "text-xs font-medium",
          tone === "danger" ? "text-danger" : tone === "warning" ? "text-warning" : "text-info",
        )}
      >
        {title}
      </p>
      <ul className="mt-1.5 list-disc space-y-1 pl-5 text-sm leading-relaxed text-foreground/95">
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

/** One question-by-question review: the transcript answer beside the reference, then what to fix. */
export function QuestionReview({
  review,
  number,
  conceptNames,
  defaultOpen,
}: {
  review: QuestionReviewData;
  number: number;
  conceptNames: ReadonlyMap<string, string>;
  defaultOpen: boolean;
}) {
  const answered = review.candidate_answer.trim() !== "";
  const hasIssues =
    review.factual_errors.length + review.missing_concepts.length + review.communication.length > 0;
  const concepts = review.concept_ids.filter((id) => conceptNames.has(id));

  return (
    <ReviewDisclosure
      id={questionAnchor(review)}
      defaultOpen={defaultOpen}
      summary={
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
              Question {number}
            </span>
            <AssessmentChip assessment={review.assessment} />
            {review.repository_area ? (
              <code className="inline-flex max-w-full items-center gap-1 rounded-md border border-brand/30 bg-brand-muted/70 px-1.5 py-px font-mono text-[11px] break-all text-brand">
                <FileCode2 className="size-3 shrink-0" aria-hidden />
                <span className="sr-only">Repository area: </span>
                {review.repository_area}
              </code>
            ) : null}
          </div>
          <p className="mt-2 text-sm leading-relaxed font-medium break-words text-foreground">{review.question}</p>
        </>
      }
    >
      <div className="grid gap-4 md:grid-cols-2">
        <div className="min-w-0 rounded-lg border bg-background/30 p-4">
          <SourceLabel title="Your answer" source="From your transcript" />
          {answered ? (
            <p className="mt-2 text-sm leading-relaxed break-words whitespace-pre-wrap text-foreground/90">
              {review.candidate_answer}
            </p>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground italic">No answer was recorded for this question.</p>
          )}
          {review.answer_truncated ? (
            <p className="mt-2 text-xs text-muted-foreground">
              Shortened here. The full answer is in the transcript below.
            </p>
          ) : null}
        </div>
        <div className="min-w-0 rounded-lg border border-brand/25 bg-brand-muted/20 p-4">
          <SourceLabel title="Expected answer" source="AI-generated reference" />
          <ReportText text={review.expected_answer} className="mt-2" />
        </div>
      </div>

      <div className="mt-5 space-y-5">
        <div>
          <SourceLabel title="What was missing or wrong" source="AI-generated" />
          {hasIssues ? (
            <div className="mt-2.5 space-y-3">
              <IssueGroup title="Factual errors" items={review.factual_errors} tone="danger" />
              <IssueGroup title="Missing or incomplete" items={review.missing_concepts} tone="warning" />
              <IssueGroup title="Communication" items={review.communication} tone="info" />
            </div>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">Nothing missing or incorrect was identified.</p>
          )}
        </div>

        {review.valid_alternatives.length > 0 ? (
          <div>
            <SourceLabel title="Also acceptable" source="AI-generated" />
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-relaxed text-foreground/95">
              {review.valid_alternatives.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <div>
          <SourceLabel title="How to improve" source="AI-generated" />
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm leading-relaxed text-foreground/95">
            {review.how_to_improve.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>
        </div>

        {review.evaluator_strengths.length + review.evaluator_gaps.length > 0 ? (
          <div className="rounded-lg border border-dashed p-4">
            <SourceLabel title="Evaluator notes" source="From the live interview evaluation" />
            <div className="mt-2.5 grid gap-3 sm:grid-cols-2">
              {review.evaluator_strengths.length > 0 ? (
                <div>
                  <p className="text-xs font-medium text-success">Went well</p>
                  <ul className="mt-1.5 list-disc space-y-1 pl-5 text-sm leading-relaxed text-muted-foreground">
                    {review.evaluator_strengths.map((item, i) => (
                      <li key={i}>{item}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {review.evaluator_gaps.length > 0 ? (
                <div>
                  <p className="text-xs font-medium text-warning">Fell short</p>
                  <ul className="mt-1.5 list-disc space-y-1 pl-5 text-sm leading-relaxed text-muted-foreground">
                    {review.evaluator_gaps.map((item, i) => (
                      <li key={i}>{item}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {concepts.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted-foreground">Related concepts:</span>
            {concepts.map((id) => (
              <a
                key={id}
                href={`#${conceptAnchor(id)}`}
                className="focus-ring rounded-full border border-brand/35 bg-brand-muted px-2.5 py-0.5 font-medium text-brand hover:bg-brand-muted/70"
              >
                {conceptNames.get(id)}
              </a>
            ))}
          </div>
        ) : null}
      </div>
    </ReviewDisclosure>
  );
}
