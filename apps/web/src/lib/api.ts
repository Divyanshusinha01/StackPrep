import {
  type ApiErrorCode,
  apiErrorSchema,
  type ConnectGithubRequest,
  connectGithubResponseSchema,
  type CreateWorkspaceRequest,
  createWorkspaceResponseSchema,
  healthResponseSchema,
  repositoryListResponseSchema,
  workspaceDetailResponseSchema,
  workspaceListResponseSchema,
} from "@stackprep/shared";
import { FunctionsHttpError } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "@/lib/supabase/server";

interface Schema<T> {
  parse(data: unknown): T;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; code: ApiErrorCode };

async function functionGet<T>(name: string, schema: Schema<T>): Promise<T> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.functions.invoke(name, { method: "GET" });
  if (error) {
    throw new Error(`Edge Function ${name} failed: ${error.message}`);
  }
  return schema.parse(data);
}

/** Like `functionGet`, but maps the backend's `{ error, code }` responses to a typed result instead of throwing. */
async function functionRequest<T>(
  name: string,
  schema: Schema<T>,
  init: { method: "GET" | "POST"; body?: Record<string, unknown> },
): Promise<ApiResult<T>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.functions.invoke(name, init);
  if (!error) {
    return { ok: true, data: schema.parse(data) };
  }
  if (error instanceof FunctionsHttpError) {
    const body = await (error.context as Response).json().catch(() => null);
    const parsed = apiErrorSchema.safeParse(body);
    if (parsed.success) {
      return { ok: false, code: parsed.data.code };
    }
  }
  return { ok: false, code: "github_unavailable" };
}

export function getHealth() {
  return functionGet("health", healthResponseSchema);
}

export function connectGithub(body: ConnectGithubRequest) {
  return functionRequest("github/connect", connectGithubResponseSchema, { method: "POST", body });
}

export function listRepositories(page = 1) {
  return functionRequest(`repositories?page=${page}&per_page=100`, repositoryListResponseSchema, { method: "GET" });
}

export function createWorkspace(body: CreateWorkspaceRequest) {
  return functionRequest("workspaces", createWorkspaceResponseSchema, { method: "POST", body });
}

export function listWorkspaces() {
  return functionRequest("workspaces", workspaceListResponseSchema, { method: "GET" });
}

export function getWorkspace(id: string) {
  return functionRequest(`workspaces/${encodeURIComponent(id)}`, workspaceDetailResponseSchema, { method: "GET" });
}
