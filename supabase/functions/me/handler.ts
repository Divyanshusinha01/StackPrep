import { type ProfileResponse, profileResponseSchema } from "@stackprep/shared";
import type { AuthContext, Authenticate } from "../_shared/auth.ts";
import { createCors, json } from "../_shared/http.ts";

export interface MeHandlerOptions {
  webOrigin: string;
  authenticate: Authenticate;
  getProfile(ctx: AuthContext): Promise<ProfileResponse | null>;
}

export async function getProfileWithRls({ user, supabase }: AuthContext): Promise<ProfileResponse | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select("id, github_login, display_name, avatar_url")
    .eq("id", user.id)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to load profile: ${error.message}`);
  }
  return data;
}

export function createMeHandler({ webOrigin, authenticate, getProfile }: MeHandlerOptions) {
  const cors = createCors(webOrigin, ["GET"]);

  return async (req: Request): Promise<Response> => {
    const rejected = cors.rejectOrigin(req);
    if (rejected) {
      return rejected;
    }

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors.headers });
    }

    if (req.method !== "GET") {
      return json({ error: "Method not allowed" }, { status: 405, headers: { ...cors.headers, Allow: "GET, OPTIONS" } });
    }

    const ctx = await authenticate(req);
    if (!ctx) {
      return json({ error: "Unauthorized" }, { status: 401, headers: cors.headers });
    }

    const profile = await getProfile(ctx);
    if (!profile) {
      return json({ error: "Profile not found" }, { status: 404, headers: cors.headers });
    }
    return json(profileResponseSchema.parse(profile), { headers: cors.headers });
  };
}
