import type { InterviewReport } from "@stackprep/shared";

const LIST = "mt-3.5 divide-y divide-border/60 rounded-xl border bg-panel/40 px-4 text-sm leading-relaxed";

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="mt-2.5 text-sm text-muted-foreground">{children}</p>;
}

export function InterviewEvidenceList({ items }: { items: InterviewReport["interview_evidence"] }) {
  if (items.length === 0) {
    return <Empty>No interview evidence was recorded.</Empty>;
  }
  return (
    <ul className={LIST}>
      {items.map((item, i) => (
        <li key={i} className="flex flex-col gap-1 py-3 sm:flex-row sm:gap-4">
          <span className="shrink-0 font-mono text-xs font-medium text-muted-foreground sm:w-44 sm:pt-0.5">
            {item.category}
          </span>
          <span className="text-foreground/95">{item.observation}</span>
        </li>
      ))}
    </ul>
  );
}

export function RepositoryEvidenceList({ items }: { items: InterviewReport["repository_evidence"] }) {
  if (items.length === 0) {
    return <Empty>No repository files were referenced.</Empty>;
  }
  return (
    <ul className={LIST}>
      {items.map((item, i) => (
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
  );
}
