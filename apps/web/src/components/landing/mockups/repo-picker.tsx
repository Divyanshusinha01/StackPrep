import { Check, Lock, Search } from "lucide-react";

import { cn } from "@/lib/utils";
import { GitHubMark } from "../github-mark";
import { Panel } from "./panel";

const REPOS = [
  { name: "acme/checkout-service", lang: "TypeScript", updated: "2h ago", selected: true },
  { name: "acme/design-tokens", lang: "CSS", updated: "3d ago" },
  { name: "acme/infra", lang: "HCL", updated: "1w ago", private: true },
  { name: "acme/mobile-app", lang: "Kotlin", updated: "2w ago" },
];

export function RepoPicker({ className }: { className?: string }) {
  return (
    <Panel
      className={className}
      title="Choose a repository"
      meta={
        <>
          <GitHubMark className="size-3.5" />
          <span>connected</span>
        </>
      }
      bodyClassName="p-2"
    >
      <div className="mb-2 flex h-8 items-center gap-2 rounded-md border bg-background/60 px-2.5 text-xs text-muted-foreground">
        <Search className="size-3.5" aria-hidden />
        <span>Search repositories</span>
      </div>
      <ul className="space-y-0.5">
        {REPOS.map((repo) => (
          <li
            key={repo.name}
            className={cn(
              "relative flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm",
              repo.selected
                ? "bg-brand-muted text-foreground before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-brand"
                : "text-muted-foreground",
            )}
          >
            <span className="truncate font-mono text-[13px]">{repo.name}</span>
            {repo.private ? (
              <>
                <Lock className="size-3 shrink-0" aria-hidden />
                <span className="sr-only">(private)</span>
              </>
            ) : null}
            <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
              {repo.lang} · {repo.updated}
            </span>
            {repo.selected ? (
              <>
                <Check className="size-3.5 shrink-0 text-brand" aria-hidden />
                <span className="sr-only">(selected)</span>
              </>
            ) : null}
          </li>
        ))}
      </ul>
    </Panel>
  );
}
