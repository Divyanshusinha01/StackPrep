import type { EvidenceExaminedPayload, SearchRepositoryInput, SearchRepositoryOutput } from "@stackprep/shared";
import { scrubSecrets } from "../../_shared/analysis/scrub.ts";
import { type MemoryEntry, type ToolContext, type ToolOutcome, topLevelArea } from "./types.ts";

export const MAX_EXCERPT_CHARS = 1500;
const MAX_TERMS = 12;
const MAX_TERM_HITS = 5;
const PATH_HIT_WEIGHT = 3;
/** "." stands for the repository as a whole (summaries that are not about one path). */
const REPOSITORY_ROOT = ".";

interface Candidate {
  path: string;
  area?: string;
  text: string;
  /** Real file path, recorded as evidence when returned. */
  isFile: boolean;
}

export interface SearchHit {
  path: string;
  area?: string;
  excerpt: string;
  isFile: boolean;
  score: number;
}

/** Ranks indexed repository memory for a query. A pgvector retriever can replace this behind the same shape. */
export type RepositorySearch = (memory: MemoryEntry[], query: string, limit: number) => SearchHit[];

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((v): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v))
    : [];
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function facts(item: Record<string, unknown>, skip: string): string {
  return Object.entries(item)
    .filter(([key]) => key !== skip)
    .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : typeof value === "object" ? JSON.stringify(value) : String(value)}`)
    .join("; ");
}

/** Splits memory rows into path-level candidates. Paths come from `structured`, never from free text. */
export function memoryCandidates(memory: MemoryEntry[]): Candidate[] {
  const out: Candidate[] = [];
  for (const row of memory) {
    const structured = row.structured ?? {};
    switch (row.kind) {
      case "file_summary": {
        const path = str(structured.path);
        if (path) {
          out.push({ path, area: topLevelArea(path), text: `${path}\n${row.content}`, isFile: true });
        }
        break;
      }
      case "key_files":
        for (const file of records(structured.files)) {
          const path = str(file.path);
          if (path) {
            out.push({ path, area: topLevelArea(path), text: `${path}\n${facts(file, "path")}`, isFile: true });
          }
        }
        break;
      case "configuration":
        for (const file of records(structured.files)) {
          const path = str(file.path);
          if (path) {
            out.push({ path, area: topLevelArea(path), text: `${path}\n${facts(file, "path")}`, isFile: true });
          }
        }
        break;
      case "dependencies":
        for (const manifest of records(structured.manifests)) {
          const path = str(manifest.manifest);
          if (path) {
            const runtime = Object.keys((manifest.runtime ?? {}) as Record<string, unknown>);
            const dev = Object.keys((manifest.dev ?? {}) as Record<string, unknown>);
            out.push({
              path,
              area: topLevelArea(path),
              text: `${path} (${str(manifest.ecosystem) ?? "unknown"})\ndependencies: ${runtime.join(", ")}\ndev: ${dev.join(", ")}`,
              isFile: true,
            });
          }
        }
        break;
      case "modules":
        for (const module of records(structured.modules)) {
          const name = str(module.name);
          if (name) {
            const role = str(module.role);
            out.push({
              path: `${name}/`,
              area: role ?? name,
              text: `${name}/ ${role ?? ""} (${String(module.files ?? "?")} files)`,
              isFile: false,
            });
          }
        }
        break;
      default:
        out.push({ path: REPOSITORY_ROOT, area: row.kind, text: [row.content, ...strings(structured.observations)].join("\n"), isFile: false });
    }
  }
  return out;
}

export function queryTerms(query: string): string[] {
  const terms = query.toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length >= 2);
  return [...new Set(terms)].slice(0, MAX_TERMS);
}

function occurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1 && count < MAX_TERM_HITS; at = haystack.indexOf(needle, at + needle.length)) {
    count++;
  }
  return count;
}

export const keywordSearch: RepositorySearch = (memory, query, limit) => {
  const terms = queryTerms(query);
  if (terms.length === 0) {
    return [];
  }
  const best = new Map<string, SearchHit>();
  for (const candidate of memoryCandidates(memory)) {
    const path = candidate.path.toLowerCase();
    const text = candidate.text.toLowerCase();
    let score = 0;
    for (const term of terms) {
      score += (path.includes(term) ? PATH_HIT_WEIGHT : 0) + occurrences(text, term);
    }
    if (score === 0) {
      continue;
    }
    const key = `${candidate.path}\u0000${candidate.area ?? ""}`;
    const current = best.get(key);
    if (!current || score > current.score) {
      best.set(key, {
        path: candidate.path,
        ...(candidate.area ? { area: candidate.area } : {}),
        excerpt: clip(scrubSecrets(candidate.text), MAX_EXCERPT_CHARS),
        isFile: candidate.isFile,
        score,
      });
    }
  }
  return [...best.values()]
    .sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .slice(0, limit);
};

export async function searchRepository(
  ctx: ToolContext,
  input: SearchRepositoryInput,
  search: RepositorySearch = keywordSearch,
): Promise<ToolOutcome> {
  const memory = await ctx.store.listRepositoryMemory(ctx.interview.workspace_id, ctx.interview.repository_commit_sha);
  const hits = search(memory, input.query, input.limit);
  const output: SearchRepositoryOutput = {
    ok: true,
    results: hits.map(({ path, area, excerpt }) => (area ? { path, area, excerpt } : { path, excerpt })),
  };
  const evidence: EvidenceExaminedPayload[] = hits
    .filter((hit) => hit.isFile && hit.path.length <= 512)
    .map((hit) => ({ path: hit.path, ...(hit.area ? { area: hit.area } : {}), tool: "search_repository" }));
  return {
    output,
    summary: { ok: true, paths: hits.map((hit) => hit.path) },
    evidence,
  };
}
