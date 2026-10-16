import { BookOpen, FileCode2, MessageSquareQuote, Target } from "lucide-react";
import type { InterviewReport } from "@stackprep/shared";
import { Surface } from "@/components/app/surface";
import { cn } from "@/lib/utils";

type StruggledQuestion = InterviewReport["struggled_questions"][number];

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

/** One "question to revisit": the repository area, the question, and how to improve on it. */
export function RevisitQuestion({ question: q }: { question: StruggledQuestion }) {
  return (
    <Surface className="overflow-hidden text-sm print:break-inside-avoid">
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
        <RevisitField icon={<Target className="size-3.5 text-warning" aria-hidden />} label="Weakness">
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
    </Surface>
  );
}
