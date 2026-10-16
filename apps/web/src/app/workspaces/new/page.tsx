import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { type ApiErrorCode, apiErrorCodeSchema, type ConnectionStatus, type RepositoryListResponse } from "@stackprep/shared";
import { ChevronLeft, ChevronRight, FolderGit2 } from "lucide-react";
import { AppShell } from "@/components/app/app-shell";
import { EmptyState } from "@/components/app/empty-state";
import { Notice } from "@/components/app/notice";
import { OpenAIKeyNotice } from "@/components/app/openai-key-notice";
import { PageHeader } from "@/components/app/page-header";
import { RepositoryPicker } from "@/components/app/repository-picker";
import { SetupChecklist } from "@/components/app/setup-checklist";
import { CTA_GLOW } from "@/components/landing/constants";
import { GitHubMark } from "@/components/landing/github-mark";
import { Button } from "@/components/ui/button";
import { getOpenAIKeyStatus, listRepositories, listWorkspaces } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { connectErrorMessage, githubInstallUrl, parseConnectError } from "@/lib/github";
import { isOpenAIKeySetupCode, keyStatusSetupCode, OPENAI_TRANSIENT_MESSAGES } from "@/lib/openai-key-setup";
import { onboardingSetupHref, openAIKeySetupHref } from "@/lib/return-to";
import { cn } from "@/lib/utils";
import { selectWorkspace } from "./actions";

export const metadata: Metadata = {
  title: "Choose a repository",
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

const WORKSPACE_ERROR_MESSAGES: Partial<Record<ApiErrorCode, string>> = {
  repository_not_accessible:
    "StackPrep can no longer access that repository. Check the GitHub App's repository access, then try again.",
  connection_not_found: "That GitHub connection no longer exists. Reload the list and try again.",
  installation_suspended: "That installation is suspended on GitHub. Unsuspend it in GitHub settings, then try again.",
  github_rate_limited: "GitHub is rate limiting requests right now. Wait a minute, then try again.",
  github_unavailable: "GitHub could not be reached. Try again in a moment.",
  ...OPENAI_TRANSIENT_MESSAGES,
};

function parseWorkspaceError(value: unknown): ApiErrorCode | null {
  const parsed = apiErrorCodeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

const CONNECTION_NOTES: Record<Exclude<ConnectionStatus["status"], "ok">, (login: string) => string> = {
  suspended: (login) => `The installation on ${login} is suspended on GitHub, so its repositories are hidden.`,
  removed: (login) => `StackPrep was uninstalled from ${login}. Connect it again to see those repositories.`,
  error: (login) => `Could not load repositories from ${login} right now.`,
};

function RepositoryList({ data, installUrl, workspaceIds, keyBlocked }: {
  data: RepositoryListResponse;
  installUrl: string | null;
  workspaceIds: Map<number, string>;
  keyBlocked: boolean;
}) {
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
        <EmptyState
          className="mt-6"
          icon={<FolderGit2 />}
          title="No repositories shared yet"
          description="No repositories are shared with StackPrep yet. Grant access to at least one repository on GitHub."
          action={installUrl ? <ConnectButton installUrl={installUrl} label="Manage GitHub access" /> : null}
        />
      ) : (
        <RepositoryPicker
          repositories={data.repositories.map((repo) => ({
            id: repo.id,
            connection_id: repo.connection_id,
            full_name: repo.full_name,
            is_private: repo.is_private,
            default_branch: repo.default_branch,
            html_url: repo.html_url,
            workspace_id: workspaceIds.get(repo.id),
          }))}
          selectAction={selectWorkspace}
          partial={data.page > 1 || data.has_more}
          nextPageHref={data.has_more ? `/workspaces/new?page=${data.page + 1}` : null}
          selectDisabled={keyBlocked}
        />
      )}

      <nav aria-label="Repository pages" className="mt-6 flex flex-wrap items-center gap-3">
        {data.page > 1 ? (
          <Button asChild variant="outline" size="sm">
            <Link href={`/workspaces/new?page=${data.page - 1}`}>
              <ChevronLeft aria-hidden />
              Previous
            </Link>
          </Button>
        ) : null}
        {data.page > 1 || data.has_more ? (
          <span className="font-mono text-xs text-muted-foreground tabular-nums" aria-current="page">
            Page {data.page}
          </span>
        ) : null}
        {data.has_more ? (
          <Button asChild variant="outline" size="sm">
            <Link href={`/workspaces/new?page=${data.page + 1}`}>
              Next
              <ChevronRight aria-hidden />
            </Link>
          </Button>
        ) : null}
        {installUrl && data.repositories.length > 0 ? (
          <a
            href={installUrl}
            className="focus-ring rounded-md text-sm text-muted-foreground hover:text-foreground sm:ml-auto"
          >
            Missing a repository? Manage GitHub access
          </a>
        ) : null}
      </nav>
    </>
  );
}

export default async function NewWorkspacePage({ searchParams }: PageProps<"/workspaces/new">) {
  const user = await requireUser("/workspaces/new");
  const params = await searchParams;
  const connectError = parseConnectError(params.github_error);
  const connected = params.connected === "1";
  const workspaceError = parseWorkspaceError(params.workspace_error);

  let installUrl: string | null = null;
  try {
    installUrl = githubInstallUrl();
  } catch {
    // Missing NEXT_PUBLIC_GITHUB_APP_SLUG: the page still lists existing connections.
  }

  const keySaved = params.key_saved === "1";

  const [result, workspaces, keyStatus] = await Promise.all([
    listRepositories(parsePage(params.page)),
    listWorkspaces(),
    getOpenAIKeyStatus(),
  ]);
  const statusCode = keyStatus.ok ? keyStatusSetupCode(keyStatus.data) : null;
  const firstRun = workspaces.ok && workspaces.data.workspaces.length === 0;
  // The key comes before connecting GitHub or picking a repository; first-run users get the guided setup.
  if (statusCode) {
    redirect(firstRun ? onboardingSetupHref("/workspaces/new") : openAIKeySetupHref("/workspaces/new"));
  }
  const keyCode = isOpenAIKeySetupCode(workspaceError) ? workspaceError : statusCode;
  // Best effort: without the list every row shows "Select", which still opens an existing workspace.
  const workspaceIds = new Map(
    workspaces.ok ? workspaces.data.workspaces.map((w) => [w.repository.github_repo_id, w.id]) : [],
  );

  return (
    <AppShell user={user} keyAlert={keyCode !== null}>
      <PageHeader
        back={{ href: "/workspaces", label: "Workspaces" }}
        title="Choose a repository"
        description="StackPrep reads repositories through its GitHub App. You choose which repositories it can access."
      />

      {connectError ? (
        <Notice tone={connectError === "install_requested" ? "info" : "error"}>
          <span className="min-w-0 flex-1">{connectErrorMessage(connectError)}</span>
          {connectError === "install_requested" ? (
            <Button asChild variant="outline" size="sm">
              <Link href="/workspaces">Back to workspaces</Link>
            </Button>
          ) : installUrl ? (
            <ConnectButton installUrl={installUrl} label="Try connecting again" variant="outline" />
          ) : null}
        </Notice>
      ) : null}
      {keySaved ? (
        <>
          <SetupChecklist keyReady className="mb-2" />
          <Notice tone="success">OpenAI key validated and saved. Now connect GitHub and choose a repository.</Notice>
        </>
      ) : null}
      {connected ? <Notice tone="success">GitHub connected. Choose a repository below.</Notice> : null}
      {keyCode ? <OpenAIKeyNotice code={keyCode} returnTo="/workspaces/new" /> : null}
      {workspaceError && !isOpenAIKeySetupCode(workspaceError) ? (
        <Notice tone="error">
          {WORKSPACE_ERROR_MESSAGES[workspaceError] ?? "Could not create the workspace. Try again."}
        </Notice>
      ) : null}

      {!result.ok ? (
        <Notice tone="error">
          <span className="min-w-0 flex-1">
            {result.code === "github_rate_limited"
              ? "GitHub is rate limiting requests right now. Wait a minute, then reload."
              : "Could not load your repositories."}
          </span>
          <Button asChild variant="outline" size="sm">
            <Link href="/workspaces/new">Reload</Link>
          </Button>
        </Notice>
      ) : result.data.connected ? (
        <RepositoryList data={result.data} installUrl={installUrl} workspaceIds={workspaceIds} keyBlocked={keyCode !== null} />
      ) : (
        <>
          {firstRun && !keySaved ? <SetupChecklist keyReady className="mt-2" /> : null}
          <EmptyState
            className="mt-6"
            icon={<GitHubMark />}
            title="Connect GitHub"
            description="Install the StackPrep GitHub App on your account or organization and pick the repositories it can read."
            action={
              installUrl ? (
                <ConnectButton installUrl={installUrl} label="Connect GitHub" />
              ) : (
                <div className="flex flex-col items-center gap-3">
                  <Notice tone="error" className="mt-0">
                    The GitHub App is not configured for this deployment.
                  </Notice>
                  <Button asChild variant="outline" size="sm">
                    <Link href="/workspaces">Back to workspaces</Link>
                  </Button>
                </div>
              )
            }
          />
        </>
      )}
    </AppShell>
  );
}
