import {
  type EvidenceExaminedPayload,
  REPOSITORY_MEMORY_EMBEDDING_DIMENSIONS,
  type SearchRepositoryInput,
  type SearchRepositoryOutput,
} from "@stackprep/shared";
import { assertEmbeddingDimensions } from "../../_shared/ai/provider.ts";
import { scrubSecrets } from "../../_shared/analysis/scrub.ts";
import {
  type MemoryEntry,
  type MemoryMatch,
  type SearchEmbeddings,
  type ToolContext,
  type ToolOutcome,
  topLevelArea,
} from "./types.ts";

export const MAX_EXCERPT_CHARS = 1500;
/** Hard upper bound for the whole vector fill (query embedding, match, mapping) on the voice path. */
export const VECTOR_SEARCH_BUDGET_MS = 3_000;
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

/** Ranks indexed repository memory for a query. Vector hits only fill what this leaves under the limit. */
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

type FallbackReason = "deadline" | "embed_error" | "rpc_error" | "no_results" | "disabled";

class VectorFallback extends Error {
  constructor(readonly reason: FallbackReason) {
    super(reason);
  }
}

/** Embeds the query and matches it against embedded memory rows; throws VectorFallback on any failure. */
async function vectorHits(
  ctx: ToolContext,
  embeddings: SearchEmbeddings,
  query: string,
  limit: number,
  signal: AbortSignal,
  onUsage: (usage: Promise<unknown>) => unknown,
): Promise<SearchHit[]> {
  const { interview } = ctx;
  let vector: number[];
  try {
    const result = await embeddings.provider.embed({ model: embeddings.model, input: [query], signal });
    onUsage(ctx.store.recordAiUsage({
      userId: ctx.userId,
      workspaceId: interview.workspace_id,
      interviewId: interview.id,
      task: "embedding",
      model: embeddings.model,
      source: "provider",
      tokens: { input_tokens: result.usage.input_tokens },
      idempotencyKey: `embedding:${interview.id}:${crypto.randomUUID()}`,
    }));
    if (result.embeddings.length !== 1) {
      throw new Error("unexpected embedding count");
    }
    assertEmbeddingDimensions(result.embeddings, REPOSITORY_MEMORY_EMBEDDING_DIMENSIONS);
    vector = result.embeddings[0];
  } catch {
    throw new VectorFallback(signal.aborted ? "deadline" : "embed_error");
  }

  let matches: MemoryMatch[];
  try {
    matches = await ctx.store.matchRepositoryMemory(interview.workspace_id, interview.repository_commit_sha, vector, limit, signal);
  } catch {
    throw new VectorFallback(signal.aborted ? "deadline" : "rpc_error");
  }
  if (matches.length === 0) {
    throw new VectorFallback("no_results");
  }
  return [...matches]
    .sort((a, b) => b.similarity - a.similarity || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0))
    .map((m) => ({
      path: REPOSITORY_ROOT,
      area: m.kind,
      excerpt: clip(scrubSecrets(m.content), MAX_EXCERPT_CHARS),
      isFile: false,
      score: m.similarity,
    }));
}

/**
 * Appends vector hits after the keyword hits, skipping duplicates by path and area, up to `limit`.
 * The whole fill (query embedding plus match) shares one deadline; on the deadline or any failure
 * the keyword hits are returned unchanged, without a retry.
 */
async function fillWithVectorHits(ctx: ToolContext, query: string, limit: number, hits: SearchHit[]): Promise<SearchHit[]> {
  const embeddings = ctx.embeddings;
  const startedAt = Date.now();
  const fallback = (reason: FallbackReason) => {
    ctx.log({ event: "repository_search_vector_fallback", reason, elapsed_ms: Date.now() - startedAt });
    return hits;
  };
  if (!embeddings) {
    return fallback("disabled");
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve();
    }, embeddings.budgetMs ?? VECTOR_SEARCH_BUDGET_MS);
  });
  const deadline = expired.then((): never => {
    throw new VectorFallback("deadline");
  });
  const usage: Promise<unknown>[] = [];
  try {
    const vector = await Promise.race([
      vectorHits(ctx, embeddings, query, limit, controller.signal, (p) => usage.push(p)),
      deadline,
    ]);
    const seen = new Set(hits.map((h) => `${h.path}\u0000${h.area ?? ""}`));
    const filled = [...hits];
    for (const hit of vector) {
      if (filled.length >= limit) {
        break;
      }
      const key = `${hit.path}\u0000${hit.area ?? ""}`;
      if (!seen.has(key)) {
        seen.add(key);
        filled.push(hit);
      }
    }
    return filled;
  } catch (err) {
    return fallback(err instanceof VectorFallback ? err.reason : "embed_error");
  } finally {
    // Recording never throws. It is awaited only until the same deadline; a write still pending then,
    // or a spend that only completes after it, is recorded in the background.
    await Promise.race([Promise.all(usage), expired]);
    clearTimeout(timer);
  }
}

export async function searchRepository(
  ctx: ToolContext,
  input: SearchRepositoryInput,
  search: RepositorySearch = keywordSearch,
): Promise<ToolOutcome> {
  const memory = await ctx.store.listRepositoryMemory(ctx.interview.workspace_id, ctx.interview.repository_commit_sha);
  const keywordHits = search(memory, input.query, input.limit);
  const hits = keywordHits.length < input.limit
    ? await fillWithVectorHits(ctx, input.query, input.limit, keywordHits)
    : keywordHits;
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
