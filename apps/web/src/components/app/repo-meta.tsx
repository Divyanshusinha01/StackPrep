import { GitBranch, Lock } from "lucide-react";

function splitFullName(fullName: string): [string, string] {
  const slash = fullName.indexOf("/");
  return slash === -1 ? ["", fullName] : [fullName.slice(0, slash + 1), fullName.slice(slash + 1)];
}

/** `owner/` muted, `repo` bold, in mono; truncation is up to the parent. */
export function RepoName({ fullName }: { fullName: string }) {
  const [ownerPrefix, repoName] = splitFullName(fullName);
  return (
    <>
      <span className="text-muted-foreground">{ownerPrefix}</span>
      <span className="font-semibold text-foreground">{repoName}</span>
    </>
  );
}

/** Private badge and default branch, shown under a repository name. */
export function RepoMeta({ isPrivate, defaultBranch }: { isPrivate: boolean; defaultBranch: string }) {
  return (
    <>
      {isPrivate ? (
        <span className="inline-flex items-center gap-1 rounded border border-border/80 bg-background/50 px-1.5 py-0.5 font-mono text-[11px]">
          <Lock className="size-3" aria-hidden />
          Private
        </span>
      ) : null}
      <span className="inline-flex items-center gap-1 font-mono text-[11px]">
        <GitBranch className="size-3" aria-hidden />
        <span className="sr-only">Default branch </span>
        {defaultBranch}
      </span>
    </>
  );
}
