"use server";

import { workspaceIdParamSchema } from "@stackprep/shared";
import { redirect } from "next/navigation";
import { retryWorkspaceAnalysis } from "@/lib/api";
import { requireUser } from "@/lib/auth";

export async function retryAnalysis(formData: FormData) {
  const parsed = workspaceIdParamSchema.safeParse(formData.get("workspace_id"));
  if (!parsed.success) {
    redirect("/workspaces");
  }
  const path = `/workspaces/${encodeURIComponent(parsed.data)}`;
  await requireUser(path);

  const result = await retryWorkspaceAnalysis(parsed.data);
  if (!result.ok) {
    redirect(`${path}?retry_error=${result.code}`);
  }
  redirect(path);
}
