import type { FileSymbol as GetFileSymbol, GetFileInput, GetFileOutput } from "@stackprep/shared";
import { classifyPath, DEFAULT_ANALYSIS_LIMITS } from "../../_shared/analysis/filter.ts";
import { scrubSecrets } from "../../_shared/analysis/scrub.ts";
import { type FileSymbol, pickFileSymbol } from "../../_shared/code-index/reader.ts";
import { type GithubApp, GithubError, GithubRateLimitedError, type RepositoryTree } from "../../_shared/github-app.ts";
import { failed, type ToolContext, type ToolOutcome, topLevelArea } from "./types.ts";

export const MAX_WINDOW_LINES = 200;
export const MAX_WINDOW_CHARS = 24_000;
export const MAX_WINDOW_SYMBOLS = 50;
const MAX_SYMBOL_NAME_CHARS = 256;
const TREE_TTL_MS = 5 * 60_000;
const MAX_CACHED_TREES = 20;

// Tree cache ---------------------------------------------------------------------------
// A commit's tree never changes, so the TTL only bounds memory and how long a revoked
// installation keeps working from cache.

export interface TreeCache {
  get(github: GithubApp, installationId: number, owner: string, name: string, commitSha: string): Promise<RepositoryTree>;
}

export function createTreeCache(now: () => number = Date.now, ttlMs = TREE_TTL_MS): TreeCache {
  const entries = new Map<string, { expiresAt: number; tree: Promise<RepositoryTree> }>();
  return {
    get(github, installationId, owner, name, commitSha) {
      const key = `${installationId}:${owner}/${name}@${commitSha}`;
      const hit = entries.get(key);
      if (hit && hit.expiresAt > now()) {
        return hit.tree;
      }
      if (entries.size >= MAX_CACHED_TREES) {
        entries.delete(entries.keys().next().value!);
      }
      const tree = github.getRepositoryTree(installationId, owner, name, commitSha);
      entries.set(key, { expiresAt: now() + ttlMs, tree });
      tree.catch(() => entries.delete(key));
      return tree;
    },
  };
}

// Paths ------------------------------------------------------------------------------------

/** A repository-relative path, or null for anything that could escape or alias one. */
export function normalizePath(raw: string): string | null {
  const path = raw.trim().replace(/^\.\//, "");
  if (!path || path.startsWith("/") || path.includes("\\") || path.includes("\0") || path.endsWith("/")) {
    return null;
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return null;
  }
  return path;
}

function decodeText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) {
    return null;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export interface FileWindow {
  startLine: number;
  endLine: number;
  totalLines: number;
  content: string;
  truncated: boolean;
}

/** At most MAX_WINDOW_LINES lines and MAX_WINDOW_CHARS characters; null for an out-of-range request. */
export function fileWindow(text: string, startLine?: number, endLine?: number): FileWindow | null {
  const lines = text.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  const totalLines = lines.length;
  const start = startLine ?? 1;
  if (totalLines === 0) {
    return start === 1 ? { startLine: 1, endLine: 0, totalLines: 0, content: "", truncated: false } : null;
  }
  const requestedEnd = Math.min(endLine ?? totalLines, totalLines);
  if (start > totalLines || (endLine !== undefined && endLine < start)) {
    return null;
  }
  let end = Math.min(requestedEnd, start + MAX_WINDOW_LINES - 1);
  let content = lines.slice(start - 1, end).join("\n");
  while (content.length > MAX_WINDOW_CHARS && end > start) {
    end = start + Math.floor((end - start) / 2);
    content = lines.slice(start - 1, end).join("\n");
  }
  const clipped = content.length > MAX_WINDOW_CHARS;
  if (clipped) {
    content = content.slice(0, MAX_WINDOW_CHARS);
  }
  return { startLine: start, endLine: end, totalLines, content, truncated: clipped || end < requestedEnd };
}

// Tool --------------------------------------------------------------------------------------

/**
 * The file's code index symbols; null when the file is not indexed or the lookup fails, so
 * reading the file never depends on the index.
 */
async function loadSymbols(ctx: ToolContext, path: string): Promise<FileSymbol[] | null> {
  try {
    return await ctx.store.listFileSymbols(ctx.interview.workspace_id, ctx.interview.repository_commit_sha, path);
  } catch {
    ctx.log({ event: "get_file_symbols_unavailable" });
    return null;
  }
}

function toOutputSymbol(s: FileSymbol): GetFileSymbol {
  return { name: s.name, kind: s.kind, ...(s.parent ? { parent: s.parent } : {}), startLine: s.start_line, endLine: s.end_line };
}

/** Declarations overlapping the window, in source order, capped. */
export function windowSymbols(symbols: readonly FileSymbol[], startLine: number, endLine: number): GetFileSymbol[] {
  return symbols
    .filter((s) => s.start_line <= endLine && s.end_line >= startLine && s.name.length <= MAX_SYMBOL_NAME_CHARS)
    .slice(0, MAX_WINDOW_SYMBOLS)
    .map(toOutputSymbol);
}

export async function getFile(ctx: ToolContext, input: GetFileInput): Promise<ToolOutcome> {
  const path = normalizePath(input.path);
  if (!path || (input.symbol !== undefined && (input.startLine !== undefined || input.endLine !== undefined))) {
    return failed("invalid_arguments");
  }
  if (classifyPath(path) !== null) {
    return failed("excluded");
  }

  const [access, symbols] = await Promise.all([
    ctx.store.getRepositoryAccess(ctx.interview.workspace_id),
    loadSymbols(ctx, path),
  ]);
  if (!access) {
    ctx.log({ event: "get_file_failed", reason: "repository_not_accessible" });
    return failed("internal", false);
  }

  let requested: FileSymbol | null = null;
  if (input.symbol !== undefined) {
    requested = symbols ? pickFileSymbol(symbols, input.symbol) : null;
    if (!requested) {
      return failed("not_found");
    }
  }

  let bytes: Uint8Array | null;
  try {
    const tree = await ctx.trees.get(ctx.github, access.installationId, access.owner, access.name, ctx.interview.repository_commit_sha);
    const entry = tree.entries.find((e) => e.path === path);
    if (!entry || entry.type !== "blob") {
      return failed("not_found");
    }
    if ((entry.size ?? 0) > DEFAULT_ANALYSIS_LIMITS.maxFileBytes) {
      return failed("excluded");
    }
    bytes = await ctx.github.getBlob(access.installationId, access.owner, access.name, entry.sha, DEFAULT_ANALYSIS_LIMITS.maxFileBytes);
  } catch (err) {
    if (!(err instanceof GithubError)) {
      throw err;
    }
    const code = err instanceof GithubRateLimitedError ? "rate_limited" : "internal";
    ctx.log({ event: "get_file_failed", reason: err.name, ...(err.status !== undefined ? { github_status: err.status } : {}) });
    return failed(code, false);
  }

  const text = bytes ? decodeText(bytes) : null;
  // Secret-bearing files are withheld entirely rather than shown with holes in them.
  if (text === null || scrubSecrets(text) !== text) {
    return failed("excluded");
  }
  const window = requested
    ? fileWindow(text, requested.start_line, requested.end_line)
    : fileWindow(text, input.startLine, input.endLine);
  if (!window) {
    return failed("invalid_arguments");
  }
  const outline = symbols && window.endLine >= window.startLine ? windowSymbols(symbols, window.startLine, window.endLine) : [];
  const symbolName = requested ? (requested.parent ? `${requested.parent}.${requested.name}` : requested.name) : null;
  const output: GetFileOutput = {
    ok: true,
    path,
    ...window,
    ...(requested ? { symbol: toOutputSymbol(requested) } : {}),
    ...(outline.length ? { symbols: outline } : {}),
  };
  const area = topLevelArea(path);
  return {
    output,
    summary: {
      ok: true,
      path,
      startLine: window.startLine,
      endLine: window.endLine,
      totalLines: window.totalLines,
      ...(symbolName ? { symbol: symbolName } : {}),
    },
    evidence: [{
      path,
      ...(area ? { area } : {}),
      tool: "get_file",
      ...(symbolName && symbolName.length <= MAX_SYMBOL_NAME_CHARS ? { symbol: symbolName } : {}),
      ...(window.endLine >= window.startLine ? { startLine: window.startLine, endLine: window.endLine } : {}),
      commit_sha: ctx.interview.repository_commit_sha,
    }],
  };
}
