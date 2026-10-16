import { ExternalLink } from "lucide-react";
import type { ReportConcept } from "@stackprep/shared";
import { Surface } from "@/components/app/surface";
import { conceptAnchor } from "./question-review";

function Resources({ concept }: { concept: ReportConcept }) {
  if (concept.resources.length === 0) {
    return (
      <p className="mt-2 rounded-lg border border-dashed px-3 py-2.5 text-sm text-muted-foreground">
        {concept.resources_status === "not_attempted"
          ? "Resources were not looked up for this concept."
          : "No reliable resources could be found for this concept right now. Search for the concept name in the official documentation for your stack."}
      </p>
    );
  }
  return (
    <ul className="mt-2 space-y-2.5">
      {concept.resources.map((resource) => (
        <li key={resource.url} className="rounded-lg border bg-background/30 p-3">
          <a
            href={resource.url}
            target="_blank"
            rel="noopener noreferrer"
            className="focus-ring inline-flex items-start gap-1.5 rounded text-sm font-medium break-words text-brand hover:underline"
          >
            {resource.title}
            <ExternalLink className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
          <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">{resource.publisher}</p>
          <p className="mt-1.5 text-sm leading-relaxed text-foreground/90">{resource.what_to_learn}</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            <span className="font-medium text-foreground/80">Addresses: </span>
            {resource.addresses}
          </p>
        </li>
      ))}
    </ul>
  );
}

/** One concept to learn: what it is, why it matters for this interview, and cited resources. */
export function ConceptCard({
  concept,
  questions,
}: {
  concept: ReportConcept;
  questions: readonly { anchor: string; number: number }[];
}) {
  return (
    <Surface
      id={conceptAnchor(concept.id)}
      className="scroll-mt-[calc(var(--app-header-h)+1.5rem)] p-4 sm:p-5 print:break-inside-avoid"
    >
      <h3 className="font-display text-base font-semibold text-foreground">{concept.name}</h3>
      {questions.length > 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Came up in{" "}
          {questions.map((q, i) => (
            <span key={q.anchor}>
              {i > 0 ? ", " : ""}
              <a href={`#${q.anchor}`} className="focus-ring rounded underline underline-offset-2 hover:text-foreground">
                question {q.number}
              </a>
            </span>
          ))}
        </p>
      ) : null}
      <p className="mt-3 text-sm leading-relaxed text-foreground/95">{concept.explanation}</p>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        <span className="font-medium text-foreground/80">Why it matters: </span>
        {concept.why_it_matters}
      </p>
      <h4 className="mt-4 font-mono text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
        Resources
      </h4>
      <Resources concept={concept} />
    </Surface>
  );
}
