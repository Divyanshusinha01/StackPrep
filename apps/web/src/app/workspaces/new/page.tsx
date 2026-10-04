import type { Metadata } from "next";
import Link from "next/link";
import type { ConnectionStatus, RepositoryListResponse } from "@stackprep/shared";
import { ExternalLink, GitBranch, Lock } from "lucide-react";
import { AppShell } from "@/components/app/app-shell";
import { CTA_GLOW } from "@/components/landing/constants";
import { GitHubMark } from "@/components/landing/github-mark";
import { Button } from "@/components/ui/button";
import { listRepositories } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { connectErrorMessage, githubInstallUrl, parseConnectError } from "@/lib/github";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Choose a repository · StackPrep",
  robots: { index: false },
};

function parsePage(value: string | string[] | undefined): number {
  const page = typeof value === "string" && /^[1-9][0-9]{0,3}$/.test(value) ? Number(value) : 1;
  return Math.min(page, 1000);
}

function ConnectButton({ installUrl, label, variant = "default" }: {
  installUrl: string;
  label: string;
  variant?: "default" | "outline";
}) {
  return (
    <Button asChild variant={variant} className={cn(variant === "default" && CTA_GLOW)}>
      <a href={installUrl}>
        <GitHubMark className="size-4" />
        {label}
      </a>
    </Button>
  );
}

function Notice({ tone, children }: { tone: "error" | "info" | "success"; children: React.ReactNode }) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "mt-6 flex flex-wrap items-center gap-3 rounded-md border px-4 py-3 text-sm",
        tone === "error" && "border-red-500/30 bg-red-500/10 text-red-300",
        tone === "info" && "border-border bg-panel/60 text-muted-foreground",
        tone === "success" && "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
      )}
    >
      {children}
    </div>
  );
}

const CONNECTION_NOTES: Record<Exclude<ConnectionStatus["status"], "ok">, (login: string) => string> = {
  suspended: (login) => `The installation on ${login} is suspended on GitHub, so its repositories are hidden.`,
  removed: (login) => `StackPrep was uninstalled from ${login}. Connect it again to see those repositories.`,
  error: (login) => `Could not load repositories from ${login} right now.`,
};

function RepositoryList({ data, installUrl }: { data: RepositoryListResponse; installUrl: string | null }) {
  const notes = data.connections.filter((c) => c.status !== "ok");

  return (
    <>
      {notes.map((c) => (
        <Notice key={c.id} tone="info">
          {CONNECTION_NOTES[c.status as Exclude<ConnectionStatus["status"], "ok">](c.account_login)}
        </Notice>
      ))}
      {data.truncated ? (
        <Notice tone="info">
          Some installations have more repositories than StackPrep can list. Select fewer repositories on GitHub to
          see the rest.
        </Notice>
      ) : null}

      {data.repositories.length === 0 ? (
        <p className="mt-8 text-sm text-muted-foreground">
          No repositories are shared with StackPrep yet. Grant access to at least one repository on GitHub.
        </p>
      ) : (
        <ul className="mt-6 divide-y rounded-lg border bg-panel/60" data-testid="repository-list">
          {data.repositories.map((repo) => (
            <li key={repo.id} className="flex items-center gap-3 px-4 py-3 text-sm">
              <span className="truncate font-mono text-[13px]">{repo.full_name}</span>
              {repo.is_private ? (
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                  <Lock className="size-3" aria-hidden />
                  Private
                </span>
              ) : null}
              <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                <GitBranch className="size-3" aria-hidden />
                {repo.default_branch}
              </span>
              <a
                href={repo.html_url}
                target="_blank"
                rel="noreferrer"
                className="rounded-md p-1 text-muted-foreground hover:text-foreground"
              >
                <ExternalLink className="size-3.5" aria-hidden />
                <span className="sr-only">Open {repo.full_name} on GitHub</span>
              </a>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-6 flex flex-wrap items-center gap-3">
        {data.page > 1 ? (
          <Button asChild variant="outline" size="sm">
            <Link href={`/workspaces/new?page=${data.page - 1}`}>Previous</Link>
          </Button>
        ) : null}
        {data.has_more ? (
          <Button asChild variant="outline" size="sm">
            <Link href={`/workspaces/new?page=${data.page + 1}`}>Next</Link>
          </Button>
        ) : null}
        {installUrl ? (
          <a href={installUrl} className="ml-auto text-sm text-muted-foreground hover:text-foreground">
            Missing a repository? Manage GitHub access
          </a>
        ) : null}
      </div>
    </>
  );
}

export default async function NewWorkspacePage({ searchParams }: PageProps<"/workspaces/new">) {
  const user = await requireUser("/workspaces/new");
  const params = await searchParams;
  const connectError = parseConnectError(params.github_error);
  const connected = params.connected === "1";

  let installUrl: string | null = null;
  try {
    installUrl = githubInstallUrl();
  } catch {
    // Missing NEXT_PUBLIC_GITHUB_APP_SLUG: the page still lists existing connections.
  }

  const result = await listRepositories(parsePage(params.page));

  return (
    <AppShell user={user}>
      <h1 className="font-display text-2xl font-semibold tracking-tight">Choose a repository</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        StackPrep reads repositories through its GitHub App. You choose which repositories it can access.
      </p>

      {connectError ? (
        <Notice tone={connectError === "install_requested" ? "info" : "error"}>
          <span>{connectErrorMessage(connectError)}</span>
          {installUrl && connectError !== "install_requested" ? (
            <ConnectButton installUrl={installUrl} label="Try connecting again" variant="outline" />
          ) : null}
        </Notice>
      ) : null}
      {connected ? <Notice tone="success">GitHub connected. Choose a repository below.</Notice> : null}

      {!result.ok ? (
        <Notice tone="error">
          <span>
            {result.code === "github_rate_limited"
              ? "GitHub is rate limiting requests right now. Wait a minute, then reload."
              : "Could not load your repositories."}
          </span>
          <Button asChild variant="outline" size="sm">
            <Link href="/workspaces/new">Reload</Link>
          </Button>
        </Notice>
      ) : result.data.connected ? (
        <RepositoryList data={result.data} installUrl={installUrl} />
      ) : (
        <div className="mt-8 rounded-lg border bg-panel/60 p-8 text-center">
          <h2 className="font-display text-lg font-semibold">Connect GitHub</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
            Install the StackPrep GitHub App on your account or organization and pick the repositories it can read.
          </p>
          <div className="mt-6">
            {installUrl ? (
              <ConnectButton installUrl={installUrl} label="Connect GitHub" />
            ) : (
              <p className="text-sm text-red-300">The GitHub App is not configured for this deployment.</p>
            )}
          </div>
        </div>
      )}
    </AppShell>
  );
}
