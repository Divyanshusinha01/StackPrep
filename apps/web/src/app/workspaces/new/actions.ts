"use server";

import { createWorkspaceRequestSchema } from "@stackprep/shared";
import { redirect } from "next/navigation";
import { createWorkspace } from "@/lib/api";
import { requireUser } from "@/lib/auth";

export async function selectWorkspace(formData: FormData) {
  await requireUser("/workspaces/new");

  const parsed = createWorkspaceRequestSchema.safeParse({
    connection_id: formData.get("connection_id"),
    github_repo_id: Number(formData.get("github_repo_id")),
  });
  if (!parsed.success) {
    redirect("/workspaces/new?workspace_error=invalid_request");
  }

  const result = await createWorkspace(parsed.data);
  if (!result.ok) {
    redirect(`/workspaces/new?workspace_error=${result.code}`);
  }
  redirect(`/workspaces/${result.data.workspace.id}`);
}
