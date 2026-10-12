/**
 * Indexes a pinned corpus with the production code index pipeline (`runCodeIndex`: file selection,
 * secret skipping, Tree-sitter parsing via @stackprep/code-parser, outlines and `buildCodeMemory`),
 * then exposes the result as the fake ToolStore that the real tools read. Files the production secret
 * check withholds have no facts here either; `summary.unindexed` lists them.
 *
 * Offline limits: symbol search uses the fake store's in-memory ranking, not the `search_code_symbols`
 * SQL, and vector matches are whatever the caller supplies, not pgvector.
 */
import { type CodeParser, createCodeParser, PARSER_VERSION } from "@stackprep/code-parser";
import type { CodeEdgeFilePayload, CodeLinkFile } from "../../../../supabase/functions/_shared/code-index/link.ts";
import type { CodeFilePayload } from "../../../../supabase/functions/_shared/code-index/mapper.ts";
import type { CodeMemoryRow } from "../../../../supabase/functions/_shared/code-index/memory.ts";
import type { FileSymbol, SymbolSearchHit } from "../../../../supabase/functions/_shared/code-index/reader.ts";
import {
  type GithubApp,
  GithubUnexpectedResponseError,
  type RepositoryTreeEntry,
} from "../../../../supabase/functions/_shared/github-app.ts";
import { runCodeIndex } from "../../../../supabase/functions/inngest/code-index.ts";
import type { CodeIndexStore } from "../../../../supabase/functions/inngest/code-index-store.ts";
import type { StepRunner } from "../../../../supabase/functions/inngest/function.ts";
import { createFakeToolStore, type FakeToolStore } from "../../../../supabase/functions/interviews/testing.ts";
import type { MemoryEntry } from "../../../../supabase/functions/interviews/tools/types.ts";
import { type CorpusSource, loadPinnedCorpus } from "./corpus-source.ts";

/** Every corpus is indexed into this workspace; the fake store ignores ids, the event schema does not. */
export const CORPUS_WORKSPACE_ID = "e7a10000-0000-4000-8000-000000000001";
const CORPUS_JOB_ID = "e7a10000-0000-4000-8000-000000000002";

export interface IndexedCorpus {
  id: string;
  label: string;
  commitSha: string;
  parserVersion: string;
  /** Every corpus file (indexed or not), for citation and line-range checks. */
  files: ReadonlyMap<string, string>;
  /** What `replace_code_index` received, in selection order. */
  codeFiles: CodeFilePayload[];
  /** What `save_code_memory` received, ordered like `listRepositoryMemory` returns it. */
  memory: MemoryEntry[];
  symbols: SymbolSearchHit[];
  fileSymbols: Record<string, FileSymbol[]>;
  summary: {
    files: number;
    selected: number;
    statuses: Record<CodeFilePayload["parse_status"], number>;
    /** Selected files without facts, with the reason (`secret` means the whole file was withheld). */
    unindexed: Record<string, string>;
    memoryRows: Record<string, number>;
    symbols: number;
  };
}

/** Pass-through step runner with Inngest's JSON round trip of step outputs. */
export const stepRunner: StepRunner = {
  async run<T>(_id: string, fn: () => Promise<T>): Promise<T> {
    return JSON.parse(JSON.stringify(await fn() ?? null)) as T;
  },
};

/**
 * Serves the corpus as one commit's tree and blobs. Blob shas are unique per path (the shared
 * `createFakeGithub` derives them from a path prefix, which collides on long repository paths).
 */
export function createCorpusGithub(files: ReadonlyMap<string, string>): GithubApp {
  const encoder = new TextEncoder();
  const paths = [...files.keys()];
  const shaOf = (index: number) => index.toString(16).padStart(40, "0");
  const bySha = new Map(paths.map((path, i) => [shaOf(i), encoder.encode(files.get(path)!)]));
  const entries: RepositoryTreeEntry[] = paths.map((path, i) => ({ path, type: "blob", sha: shaOf(i), size: bySha.get(shaOf(i))!.length }));
  const unsupported = () => Promise.reject(new GithubUnexpectedResponseError());
  return {
    verifyUserInstallation: unsupported,
    getInstallation: unsupported,
    listAllInstallationRepositories: unsupported,
    getRepositoryHead: unsupported,
    getRepositoryTree: () => Promise.resolve({ entries: structuredClone(entries), truncated: false }),
    getBlob: (_i, _o, _n, sha, maxBytes) => {
      const bytes = bySha.get(sha);
      return Promise.resolve(bytes && bytes.length <= maxBytes ? bytes.slice() : null);
    },
    _internal: { getInstallationToken: unsupported, createAppJwt: unsupported },
  };
}

/** Runs the production code index over the corpus and collects what it would persist. */
export async function indexCorpus(source: CorpusSource, options: { parser?: CodeParser } = {}): Promise<IndexedCorpus> {
  const { manifest, files } = source;
  const codeFiles: CodeFilePayload[] = [];
  const edgeFiles: CodeEdgeFilePayload[] = [];
  const saved: { rows: CodeMemoryRow[] | null } = { rows: null };
  const logs: string[] = [];
  const store: CodeIndexStore = {
    loadTarget: () =>
      Promise.resolve({
        job_id: CORPUS_JOB_ID,
        job_status: "queued",
        workspace_id: CORPUS_WORKSPACE_ID,
        commit_sha: manifest.commit_sha,
        owner: "eval",
        name: manifest.id,
        installation_id: 1,
        suspended: false,
      }),
    markStage: () => Promise.resolve(),
    loadReusable: () => Promise.resolve([]),
    replaceFiles: (_w, _c, _v, batch) => {
      codeFiles.push(...batch);
      return Promise.resolve(batch.length);
    },
    loadLinkFacts: (_w, _c, afterPath, limit) =>
      Promise.resolve(
        codeFiles
          .filter((f) => (f.parse_status === "ok" || f.parse_status === "partial") && (afterPath === null || f.path > afterPath))
          .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
          .slice(0, limit)
          .map((f): CodeLinkFile => ({
            path: f.path,
            language: f.language,
            symbols: f.symbols.map((s) => ({ name: s.name, kind: s.kind, parent_ord: s.parent_ord, exported: s.exported, signature: s.signature })),
            imports: f.imports.map((i) => ({ source: i.source, kind: i.kind, names: i.names })),
            calls: f.calls.map((c) => ({ caller_ord: c.caller_ord, callee_text: c.callee_text })),
          })),
      ),
    replaceEdges: (_w, _c, batch) => {
      edgeFiles.push(...batch);
      return Promise.resolve(batch.reduce((n, f) => n + f.edges.length, 0));
    },
    saveMemory: (_w, _j, _c, rows) => {
      saved.rows = rows;
      return Promise.resolve(rows.length);
    },
    complete: () => Promise.resolve(),
    listRetainedCommits: () => Promise.resolve([]),
    prune: () => Promise.resolve(0),
    fail: () => Promise.resolve(),
  };

  const parser = options.parser ?? createCodeParser();
  try {
    await runCodeIndex(
      {
        github: createCorpusGithub(files),
        store,
        jobs: { enqueue: () => Promise.resolve({ eventId: "eval" }) },
        parser,
        log: (line) => logs.push(line),
      },
      {
        data: { workspace_id: CORPUS_WORKSPACE_ID, job_id: CORPUS_JOB_ID, commit_sha: manifest.commit_sha },
        runId: "eval",
        step: stepRunner,
      },
    );
  } finally {
    if (!options.parser) {
      parser.dispose();
    }
  }
  const rows = saved.rows;
  if (rows === null) {
    throw new Error(`corpus ${manifest.id}: the code index saved no memory (${logs.at(-1) ?? "no log"})`);
  }

  const parsed = codeFiles.filter((f) => f.parse_status === "ok" || f.parse_status === "partial");
  const parentName = (file: CodeFilePayload, ord: number | null) => (ord === null ? null : file.symbols[ord].name);
  const symbols: SymbolSearchHit[] = parsed.flatMap((file) =>
    file.symbols.map((s) => ({
      path: file.path,
      language: file.language,
      name: s.name,
      kind: s.kind,
      parent_name: parentName(file, s.parent_ord),
      start_line: s.start_line,
      end_line: s.end_line,
      exported: s.exported,
      signature: s.signature,
      matched_terms: 0,
    }))
  );
  const fileSymbols: Record<string, FileSymbol[]> = Object.fromEntries(parsed.map((file) => [
    file.path,
    file.symbols.map((s) => ({
      name: s.name,
      kind: s.kind,
      parent: parentName(file, s.parent_ord),
      start_line: s.start_line,
      end_line: s.end_line,
      exported: s.exported,
    })),
  ]));
  // listRepositoryMemory orders by kind, then insertion id.
  const memory: MemoryEntry[] = rows
    .map((row, id) => ({ row, id }))
    .sort((a, b) => (a.row.kind < b.row.kind ? -1 : a.row.kind > b.row.kind ? 1 : a.id - b.id))
    .map(({ row }) => ({ kind: row.kind, content: row.content, structured: row.structured }));

  const statuses: IndexedCorpus["summary"]["statuses"] = { ok: 0, partial: 0, failed: 0, unsupported: 0, skipped: 0 };
  const unindexed: Record<string, string> = {};
  for (const file of codeFiles) {
    statuses[file.parse_status]++;
    if (file.parse_status !== "ok" && file.parse_status !== "partial") {
      unindexed[file.path] = file.skipped_reason ?? file.parse_status;
    }
  }
  const memoryRows: Record<string, number> = {};
  for (const row of memory) {
    memoryRows[row.kind] = (memoryRows[row.kind] ?? 0) + 1;
  }
  return {
    id: manifest.id,
    label: manifest.label,
    commitSha: manifest.commit_sha,
    parserVersion: PARSER_VERSION,
    files,
    codeFiles,
    memory,
    symbols,
    fileSymbols,
    summary: {
      files: files.size,
      selected: codeFiles.length,
      statuses,
      unindexed: Object.fromEntries(Object.entries(unindexed).sort(([a], [b]) => (a < b ? -1 : 1))),
      memoryRows,
      symbols: symbols.length,
    },
  };
}

/** Loads and indexes the corpus pinned under `id`, relative to the project directory. */
export async function loadIndexedCorpus(projectDir: URL, id: string, options: { parser?: CodeParser } = {}): Promise<IndexedCorpus> {
  return indexCorpus(await loadPinnedCorpus(projectDir, id), options);
}

/**
 * The fake ToolStore over an indexed corpus: memory rows, symbols and file outlines come from the
 * index. Fresh copies each call, so one case cannot leak state into the next.
 */
export function createCorpusToolStore(
  corpus: IndexedCorpus,
  init: Parameters<typeof createFakeToolStore>[0] = {},
): FakeToolStore {
  return createFakeToolStore({
    memory: structuredClone(corpus.memory),
    symbols: structuredClone(corpus.symbols),
    fileSymbols: structuredClone(corpus.fileSymbols),
    access: { installationId: 1, owner: "eval", name: corpus.id },
    ...init,
  });
}
