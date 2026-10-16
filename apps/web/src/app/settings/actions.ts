"use server";

import { saveOpenAIKeyRequestSchema } from "@stackprep/shared";
import { redirect } from "next/navigation";
import { type ApiResult, deleteOpenAIKey, revalidateOpenAIKey, saveOpenAIKey } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { settingsReturnPath } from "@/lib/return-to";

interface Context {
  returnTo: string | null;
  onboarding: boolean;
}

function context(formData: FormData): Context {
  return { returnTo: settingsReturnPath(formData.get("return_to")), onboarding: formData.get("onboarding") === "1" };
}

/** Never carries the key: only an outcome flag or error code, the model id, and the return path. */
function settingsUrl(params: Record<string, string>, { returnTo, onboarding }: Context): string {
  const query = new URLSearchParams(params);
  if (returnTo) {
    query.set("return_to", returnTo);
  }
  if (onboarding) {
    query.set("onboarding", "1");
  }
  return `/settings?${query}`;
}

function failureUrl(result: Extract<ApiResult<unknown>, { ok: false }>, ctx: Context): string {
  return settingsUrl({ error: result.code, ...(result.model ? { model: result.model } : {}) }, ctx);
}

/** First-run setup moves straight on to the repository step once the key is saved. */
function savedUrl(ctx: Context): string {
  return ctx.onboarding ? `${ctx.returnTo ?? "/workspaces/new"}?key_saved=1` : settingsUrl({ saved: "1" }, ctx);
}

export async function saveOpenAIKeyAction(formData: FormData) {
  await requireUser("/settings");
  const ctx = context(formData);

  const parsed = saveOpenAIKeyRequestSchema.safeParse({ api_key: formData.get("api_key") });
  if (!parsed.success) {
    redirect(settingsUrl({ error: "invalid_request" }, ctx));
  }
  const result = await saveOpenAIKey(parsed.data.api_key);
  redirect(result.ok ? savedUrl(ctx) : failureUrl(result, ctx));
}

export async function revalidateOpenAIKeyAction(formData: FormData) {
  await requireUser("/settings");
  const ctx = context(formData);
  const result = await revalidateOpenAIKey();
  redirect(result.ok ? settingsUrl({ validated: "1" }, ctx) : failureUrl(result, ctx));
}

export async function deleteOpenAIKeyAction(formData: FormData) {
  await requireUser("/settings");
  const ctx = context(formData);
  const result = await deleteOpenAIKey();
  redirect(result.ok ? settingsUrl({ deleted: "1" }, ctx) : failureUrl(result, ctx));
}
