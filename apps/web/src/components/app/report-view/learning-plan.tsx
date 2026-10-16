import { Clock } from "lucide-react";
import type { LearningPlanItem } from "@stackprep/shared";
import { conceptAnchor } from "./question-review";

function formatEffort(minutes: number) {
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** The prioritized practice plan; each step has a concrete exercise and a way to check it worked. */
export function LearningPlan({
  items,
  conceptNames,
}: {
  items: LearningPlanItem[];
  conceptNames: ReadonlyMap<string, string>;
}) {
  if (items.length === 0) {
    return <p className="mt-2.5 text-sm text-muted-foreground">No learning plan was produced for this interview.</p>;
  }
  const sorted = [...items].sort((a, b) => a.priority - b.priority);
  return (
    <ol className="mt-4 space-y-3">
      {sorted.map((item, i) => {
        const concept = item.concept_id ? conceptNames.get(item.concept_id) : undefined;
        return (
          <li
            key={i}
            className="surface-inset flex gap-4 rounded-xl border bg-panel/60 p-4 sm:p-5 print:break-inside-avoid"
          >
            <span
              aria-hidden
              className="grid size-7 shrink-0 place-items-center rounded-full border border-brand/35 bg-brand-muted font-mono text-xs font-semibold text-brand"
            >
              {i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <span className="sr-only">Priority {i + 1}: </span>
              <p className="text-sm leading-relaxed font-medium text-foreground">{item.exercise}</p>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                <span className="font-medium text-foreground/80">Done when: </span>
                {item.success_check}
              </p>
              <div className="mt-2.5 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  <Clock className="size-3.5" aria-hidden />
                  <span className="sr-only">Estimated effort: </span>
                  {formatEffort(item.effort_minutes)}
                </span>
                {concept ? (
                  <a
                    href={`#${conceptAnchor(item.concept_id)}`}
                    className="focus-ring rounded-full border border-brand/35 bg-brand-muted px-2.5 py-0.5 font-medium text-brand"
                  >
                    {concept}
                  </a>
                ) : null}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
