"use client";

import { useDeferredValue, useId, useState } from "react";
import Link from "next/link";
import { ArrowRight, ExternalLink, GitBranch, Lock, Search, X } from "lucide-react";
import { EmptyState } from "@/components/app/empty-state";
import { StatusChip } from "@/components/app/status-chip";
import { SubmitButton } from "@/components/app/submit-button";
import { Button } from "@/components/ui/button";

export interface PickerRepository {
  id: number;
  connection_id: string;
  full_name: string;
  is_private: boolean;
  default_branch: string;
  html_url: string;
  /** Set when the repository already has a workspace. */
  workspace_id: string | undefined;
}

/** Repositories on the current page with a client-side filter; "Open" for existing workspaces, "Select" otherwise. */
export function RepositoryPicker({
  repositories,
  selectAction,
  partial,
}: {
  repositories: PickerRepository[];
  selectAction: (formData: FormData) => Promise<void>;
  /** The list is one page of several, so the filter only covers this page. */
  partial: boolean;
}) {
  const inputId = useId();
  const [query, setQuery] = useState("");
  const deferred = useDeferredValue(query.trim().toLowerCase());
  const visible = deferred ? repositories.filter((r) => r.full_name.toLowerCase().includes(deferred)) : repositories;

  return (
    <div className="mt-6">
      <div className="relative">
        <label htmlFor={inputId} className="sr-only">
          {partial ? "Filter repositories on this page" : "Filter repositories"}
        </label>
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <input
          id={inputId}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={partial ? "Filter repositories on this page…" : "Filter repositories…"}
          autoComplete="off"
          spellCheck={false}
          className="h-10 w-full rounded-lg border border-input bg-input/20 pr-10 pl-9 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 [&::-webkit-search-cancel-button]:hidden"
        />
        {query ? (
          <button
            type="button"
            onClick={() => setQuery("")}
            className="focus-ring absolute top-1/2 right-1.5 grid size-7 -translate-y-1/2 place-items-center rounded-md text-muted-foreground hover:text-foreground"
          >
            <X className="size-4" aria-hidden />
            <span className="sr-only">Clear filter</span>
          </button>
        ) : null}
      </div>
      <p className="sr-only" aria-live="polite">
        {deferred ? `${visible.length} of ${repositories.length} repositories match` : ""}
      </p>

      {visible.length === 0 ? (
        <EmptyState
          className="mt-4 py-8"
          icon={<Search />}
          title="No matching repositories"
          description={`No repositories ${partial ? "on this page " : ""}match “${query.trim()}”.`}
          action={
            <Button variant="outline" size="sm" onClick={() => setQuery("")}>
              Clear filter
            </Button>
          }
        />
      ) : (
        <ul className="mt-4 divide-y overflow-hidden rounded-xl border bg-panel/60" data-testid="repository-list">
          {visible.map((repo) => (
            <li
              key={repo.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 text-sm transition-colors hover:bg-panel-raised/60"
            >
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate font-mono text-[13px] font-medium">{repo.full_name}</span>
                  <a
                    href={repo.html_url}
                    target="_blank"
                    rel="noreferrer"
                    className="focus-ring grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:text-foreground"
                  >
                    <ExternalLink className="size-3.5" aria-hidden />
                    <span className="sr-only">Open {repo.full_name} on GitHub</span>
                  </a>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  {repo.is_private ? (
                    <span className="inline-flex items-center gap-1">
                      <Lock className="size-3" aria-hidden />
                      Private
                    </span>
                  ) : null}
                  <span className="inline-flex items-center gap-1">
                    <GitBranch className="size-3" aria-hidden />
                    {repo.default_branch}
                  </span>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {repo.workspace_id ? (
                  <>
                    <StatusChip tone="brand" className="hidden sm:inline-flex">
                      Has workspace
                    </StatusChip>
                    <Button asChild variant="outline" size="sm">
                      <Link href={`/workspaces/${repo.workspace_id}`} aria-label={`Open workspace for ${repo.full_name}`}>
                        Open
                        <ArrowRight aria-hidden />
                      </Link>
                    </Button>
                  </>
                ) : (
                  <form action={selectAction}>
                    <input type="hidden" name="connection_id" value={repo.connection_id} />
                    <input type="hidden" name="github_repo_id" value={repo.id} />
                    <SubmitButton size="sm" pendingLabel="Selecting…" aria-label={`Select ${repo.full_name}`}>
                      Select
                    </SubmitButton>
                  </form>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
