import { ChevronRight, FileText, Play } from "lucide-react";

import { cn } from "@/lib/utils";
import { Panel } from "./panel";

const INTERVIEWS = [
  { name: "Interview 2", date: "Sep 24", status: "Completed" },
  { name: "Interview 1", date: "Sep 18", status: "Completed" },
];

export function WorkspacePanel({ className, glow }: { className?: string; glow?: boolean }) {
  return (
    <Panel
      className={className}
      glow={glow}
      title="acme/checkout-service"
      meta={<span className="rounded border px-1.5 py-px text-[10px] uppercase tracking-wider">Workspace</span>}
      bodyClassName="space-y-4 p-4"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="flex items-center gap-2 text-sm font-medium text-foreground">
            <span className="size-1.5 rounded-full bg-success" aria-hidden />
            Interview-ready
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Baseline analysis complete · deeper analysis running
          </p>
        </div>
        {/* Static mockup of the in-app control, intentionally not interactive. */}
        <span className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground">
          <Play className="size-3 fill-current" aria-hidden />
          Start interview
        </span>
      </div>

      <div className="rounded-lg border bg-background/40 p-3">
        <p className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">Repository</p>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-foreground/80">
          <span>142 files</span>
          <span>TypeScript · Next.js</span>
          <span>PostgreSQL</span>
        </div>
      </div>

      <div>
        <p className="mb-2 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
          Interview history
        </p>
        <ul className="divide-y rounded-lg border">
          {INTERVIEWS.map((item, i) => (
            <li key={item.name} className="flex items-center gap-3 px-3 py-2.5 text-sm">
              <span className="text-foreground/90">{item.name}</span>
              <span className="text-xs text-muted-foreground">{item.date}</span>
              <span
                className={cn(
                  "ml-auto inline-flex items-center gap-1 text-xs",
                  i === 0 ? "text-brand" : "text-muted-foreground",
                )}
              >
                <FileText className="size-3" aria-hidden />
                Report
                <ChevronRight className="size-3" aria-hidden />
              </span>
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  );
}
