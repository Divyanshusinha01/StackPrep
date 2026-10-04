import { connectGithubRequestSchema } from "@stackprep/shared";
import { type NextRequest, NextResponse } from "next/server";
import { connectGithub } from "@/lib/api";
import { getUser } from "@/lib/auth";
import type { ConnectError } from "@/lib/github";

const PICKER_PATH = "/workspaces/new";

/**
 * GitHub App setup URL. A route handler rather than a page: the OAuth code is single-use, so it is
 * exchanged exactly once here and the browser is redirected away before anything can replay it.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin, pathname, search } = request.nextUrl;

  if (!(await getUser())) {
    const loginUrl = new URL("/login", origin);
    loginUrl.searchParams.set("next", `${pathname}${search}`);
    return NextResponse.redirect(loginUrl);
  }

  const picker = (params: { github_error?: ConnectError; connected?: string } = {}) => {
    const url = new URL(PICKER_PATH, origin);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    return NextResponse.redirect(url);
  };

  const setupAction = searchParams.get("setup_action");
  if (setupAction === "request") {
    return picker({ github_error: "install_requested" });
  }

  const code = searchParams.get("code");
  if (!code) {
    // Repository access changes on an existing installation may arrive without a code; the picker lists repositories live.
    return setupAction === "update" ? picker() : picker({ github_error: "missing_code" });
  }

  const parsed = connectGithubRequestSchema.safeParse({
    code,
    installation_id: Number(searchParams.get("installation_id")),
  });
  if (!parsed.success) {
    return picker({ github_error: "invalid_request" });
  }

  const result = await connectGithub(parsed.data);
  if (!result.ok) {
    return picker({ github_error: result.code });
  }
  return picker({ connected: "1" });
}
