import type { SupabaseClient } from "@supabase/supabase-js";
import { type AiUsageRecorder, createAiUsageRecorder } from "../_shared/ai-usage.ts";

/** A memory row without its vector; `has_embedding` comes from a separate id-only query. */
export interface EmbeddingMemoryRow {
  id: string;
  kind: string;
  content: string;
  metadata: Record<string, unknown>;
  /** Compare-and-set guard for the embedding write. */
  updated_at: string;
  has_embedding: boolean;
}

/** Stored under `metadata.embedding` next to the vector it describes. */
export interface EmbeddingMarker {
  model: string;
  dimensions: number;
  input_hash: string;
  input_version: string;
  embedded_at: string;
}

/** Service-role persistence for the embedding run. Every call is keyed by workspace id. */
export interface MemoryEmbeddingStore extends AiUsageRecorder {
  /** The workspace owner, or null when the workspace does not exist. */
  loadWorkspaceUser(workspaceId: string): Promise<string | null>;
  /** Rows of exactly one commit, optionally limited to `ids`. Never selects the vectors. */
  loadRows(workspaceId: string, commitSha: string, ids?: string[]): Promise<EmbeddingMemoryRow[]>;
  /**
   * Sets the vector and the whole `metadata` only while `updated_at` still equals `expectedUpdatedAt`.
   * Returns false when the row changed (or vanished) since it was loaded.
   */
  writeEmbedding(
    workspaceId: string,
    id: string,
    expectedUpdatedAt: string,
    embedding: number[],
    metadata: Record<string, unknown>,
  ): Promise<boolean>;
}

function check(action: string, error: { message: string } | null): void {
  if (error) {
    throw new Error(`Failed to ${action}: ${error.message}`);
  }
}

export function createMemoryEmbeddingStore(serviceClient: SupabaseClient): MemoryEmbeddingStore {
  return {
    ...createAiUsageRecorder(serviceClient),

    async loadWorkspaceUser(workspaceId) {
      const { data, error } = await serviceClient.from("workspaces").select("user_id").eq("id", workspaceId).maybeSingle();
      check("load workspace", error);
      return data?.user_id ?? null;
    },

    async loadRows(workspaceId, commitSha, ids) {
      let rowsQuery = serviceClient.from("repository_memory").select("id, kind, content, metadata, updated_at")
        .eq("workspace_id", workspaceId).eq("repository_commit_sha", commitSha);
      let missingQuery = serviceClient.from("repository_memory").select("id")
        .eq("workspace_id", workspaceId).eq("repository_commit_sha", commitSha).is("embedding", null);
      if (ids) {
        rowsQuery = rowsQuery.in("id", ids);
        missingQuery = missingQuery.in("id", ids);
      }
      const [rows, missing] = await Promise.all([rowsQuery.order("id"), missingQuery]);
      check("load repository memory", rows.error);
      check("load missing embeddings", missing.error);
      const withoutEmbedding = new Set((missing.data ?? []).map((r) => r.id as string));
      return (rows.data ?? []).map((r) => ({
        id: r.id,
        kind: r.kind,
        content: r.content,
        metadata: (r.metadata ?? {}) as Record<string, unknown>,
        updated_at: r.updated_at,
        has_embedding: !withoutEmbedding.has(r.id),
      }));
    },

    async writeEmbedding(workspaceId, id, expectedUpdatedAt, embedding, metadata) {
      const { data, error } = await serviceClient
        .from("repository_memory")
        .update({ embedding: JSON.stringify(embedding), metadata })
        .eq("id", id)
        .eq("workspace_id", workspaceId)
        .eq("updated_at", expectedUpdatedAt)
        .select("id");
      check("write embedding", error);
      return (data ?? []).length > 0;
    },
  };
}
