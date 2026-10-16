"use client";

import { useDeferredValue, useId, useState } from "react";
import Link from "next/link";
import { ArrowRight, ChevronRight, ExternalLink, Search, X } from "lucide-react";
import { EmptyState } from "@/components/app/empty-state";
import { RepoMeta, RepoName } from "@/components/app/repo-meta";
import { StatusChip } from "@/components/app/status-chip";
import { SubmitButton } from "@/components/app/submit-button";
import { SurfaceList } from "@/components/app/surface";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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
  nextPageHref = null,
  selectDisabled = false,
}: {
  repositories: PickerRepository[];
  selectAction: (formData: FormData) => Promise<void>;
  /** The list is one page of several, so the filter only covers this page. */
  partial: boolean;
  /** Link to the next page of repositories, when there is one. */
  nextPageHref?: string | null;
  /** New workspaces need a working OpenAI key; existing ones can still be opened. */
  selectDisabled?: boolean;
}) {
  const inputId = useId();
  const blockedId = useId();
  const [query, setQuery] = useState("");
  const deferred = useDeferredValue(query.trim().toLowerCase());
  const visible = deferred ? repositories.filter((r) => r.full_name.toLowerCase().includes(deferred)) : repositories;

  return (
    <div className="mt-6">
      <div className="relative">
        <label htmlFor={inputId} className="sr-only">
          {partial ? "Filter repositories on this page" : "Filter repositories"}
        </label>
        <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          id={inputId}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={partial ? "Filter repositories on this page…" : "Filter repositories…"}
          autoComplete="off"
          spellCheck={false}
          className="rounded-lg bg-panel/80 pr-28 pl-10"
        />
        <div className="absolute top-1/2 right-2 flex -translate-y-1/2 items-center gap-1.5">
          <span
            aria-hidden
            className="pointer-events-none rounded border border-border/80 bg-background/60 px-2 py-0.5 font-mono text-[11px] text-muted-foreground tabular-nums"
          >
            {deferred ? `${visible.length}/${repositories.length}` : `${repositories.length}`}{" "}
            {repositories.length === 1 && !deferred ? "repo" : "repos"}
          </span>
          {query ? (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="focus-ring grid size-7 place-items-center rounded-md text-muted-foreground hover:text-foreground"
            >
              <X className="size-4" aria-hidden />
              <span className="sr-only">Clear filter</span>
            </button>
          ) : null}
        </div>
      </div>
      <p className="sr-only" aria-live="polite">
        {deferred ? `${visible.length} of ${repositories.length} repositories match` : ""}
      </p>
      {selectDisabled ? (
        <p id={blockedId} className="mt-3 text-xs text-muted-foreground">
          Add a working OpenAI key to create a workspace. Existing workspaces can still be opened.
        </p>
      ) : null}

      {visible.length === 0 ? (
        <EmptyState
          className="mt-4 py-8"
          icon={<Search />}
          title="No matching repositories"
          description={
            nextPageHref
              ? `No repositories on this page match “${query.trim()}”. It may be on a later page.`
              : `No repositories ${partial ? "on this page " : ""}match “${query.trim()}”.`
          }
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setQuery("")}>
                Clear filter
              </Button>
              {nextPageHref ? (
                <Button asChild variant="outline" size="sm">
                  <Link href={nextPageHref}>
                    Next page
                    <ChevronRight aria-hidden />
                  </Link>
                </Button>
              ) : null}
            </div>
          }
        />
      ) : (
        <SurfaceList className="mt-4" data-testid="repository-list">
          {visible.map((repo) => (
            <li
              key={repo.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3.5 text-sm transition-colors hover:bg-panel-raised/60 sm:px-5"
            >
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate font-mono text-sm">
                    <RepoName fullName={repo.full_name} />
                  </span>
                  <a
                    href={repo.html_url}
                    target="_blank"
                    rel="noreferrer"
                    className="focus-ring grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:text-foreground"
                  >
                    <ExternalLink className="size-3.5" aria-hidden />
                    <span className="sr-only">Open {repo.full_name} on GitHub (opens in a new tab)</span>
                  </a>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3.5 gap-y-1 text-xs text-muted-foreground">
                  <RepoMeta isPrivate={repo.is_private} defaultBranch={repo.default_branch} />
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
                    <SubmitButton
                      size="sm"
                      pendingLabel="Selecting…"
                      disabled={selectDisabled}
                      aria-label={`Select ${repo.full_name}`}
                      aria-describedby={selectDisabled ? blockedId : undefined}
                    >
                      Select
                    </SubmitButton>
                  </form>
                )}
              </div>
            </li>
          ))}
        </SurfaceList>
      )}
    </div>
  );
}
