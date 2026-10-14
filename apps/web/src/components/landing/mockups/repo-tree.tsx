import { FileCode, FileText, FolderOpen, GitBranch } from "lucide-react";

import { cn } from "@/lib/utils";
import { Panel } from "./panel";

type TreeNode = { path: string; depth: number; kind: "dir" | "file" };

export const REPO_TREE: TreeNode[] = [
  { path: "src/", depth: 0, kind: "dir" },
  { path: "src/api/", depth: 1, kind: "dir" },
  { path: "src/api/checkout.ts", depth: 2, kind: "file" },
  { path: "src/api/middleware.ts", depth: 2, kind: "file" },
  { path: "src/api/webhooks.ts", depth: 2, kind: "file" },
  { path: "src/auth/", depth: 1, kind: "dir" },
  { path: "src/auth/session.ts", depth: 2, kind: "file" },
  { path: "src/auth/oauth.ts", depth: 2, kind: "file" },
  { path: "src/components/", depth: 1, kind: "dir" },
  { path: "src/components/CartSummary.tsx", depth: 2, kind: "file" },
  { path: "src/lib/", depth: 1, kind: "dir" },
  { path: "src/lib/db.ts", depth: 2, kind: "file" },
  { path: "src/lib/queue.ts", depth: 2, kind: "file" },
  { path: "package.json", depth: 0, kind: "file" },
  { path: "README.md", depth: 0, kind: "file" },
];

/** Fixed row height so overlays (e.g. relationship lines) can be positioned by row index. */
export const TREE_ROW_HEIGHT = 28;

export function treeRowIndex(path: string) {
  return REPO_TREE.findIndex((node) => node.path === path);
}

function nodeName(node: TreeNode) {
  const trimmed = node.path.replace(/\/$/, "");
  const name = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return node.kind === "dir" ? `${name}/` : name;
}

type RepoTreeProps = {
  className?: string;
  highlight?: string[];
  limit?: number;
  /** Absolutely positioned layer rendered over the rows, e.g. connector lines. */
  overlay?: React.ReactNode;
  showStack?: boolean;
};

export function RepoTree({
  className,
  highlight = [],
  limit,
  overlay,
  showStack = true,
}: RepoTreeProps) {
  const rows = limit ? REPO_TREE.slice(0, limit) : REPO_TREE;

  return (
    <Panel
      label="Example repository file tree with the files the analysis highlighted"
      className={className}
      title="acme/checkout-service"
      meta={
        <>
          <GitBranch className="size-3.5" aria-hidden />
          <span>main</span>
        </>
      }
      bodyClassName="p-2"
    >
      <div className="relative">
        <ul className="font-mono text-[12.5px]">
          {rows.map((node) => {
            const active = highlight.includes(node.path);
            const Icon =
              node.kind === "dir" ? FolderOpen : node.path.endsWith(".md") ? FileText : FileCode;
            return (
              <li
                key={node.path}
                style={{ height: TREE_ROW_HEIGHT, paddingLeft: 8 + node.depth * 16 }}
                className={cn(
                  "flex items-center gap-2 rounded-md pr-2",
                  active
                    ? "bg-brand-muted text-foreground shadow-[inset_2px_0_0_var(--brand),0_0_20px_-8px_var(--brand-glow)]"
                    : "text-muted-foreground",
                )}
              >
                <Icon
                  className={cn(
                    "size-3.5 shrink-0",
                    active ? "text-brand" : node.kind === "dir" ? "text-foreground/50" : "text-foreground/35",
                  )}
                  aria-hidden
                />
                <span className="truncate">{nodeName(node)}</span>
              </li>
            );
          })}
        </ul>
        {overlay}
      </div>
      {showStack ? (
        <div className="mt-2 flex flex-wrap gap-1.5 border-t px-2 pt-3 pb-1">
          {["TypeScript", "Next.js", "PostgreSQL", "Stripe"].map((tech) => (
            <span
              key={tech}
              className="rounded border bg-background/50 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
            >
              {tech}
            </span>
          ))}
        </div>
      ) : null}
    </Panel>
  );
}
