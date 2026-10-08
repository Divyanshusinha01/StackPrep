import { notFound } from "next/navigation";
import { getWorkspace } from "@/lib/api";
import { getUser } from "@/lib/auth";

/**
 * Checks the workspace exists before the page's loading boundary starts streaming, so a missing
 * workspace answers 404 rather than 200. Signed-out visitors fall through to the page's login redirect.
 */
export default async function WorkspaceLayout({ children, params }: LayoutProps<"/workspaces/[id]">) {
  const { id } = await params;
  if (await getUser()) {
    const result = await getWorkspace(id);
    if (!result.ok && result.code === "workspace_not_found") {
      notFound();
    }
  }
  return children;
}
