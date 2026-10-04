"use server";

import { safeNextPath } from "@stackprep/shared";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function signInWithGitHub(formData: FormData) {
  const next = safeNextPath(formData.get("next")?.toString());
  const origin = (await headers()).get("origin");
  if (!origin) {
    redirect("/login?error=origin");
  }

  const callback = new URL("/auth/callback", origin);
  callback.searchParams.set("next", next);

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "github",
    options: { redirectTo: callback.toString() },
  });

  if (error || !data.url) {
    redirect(`/login?error=oauth&next=${encodeURIComponent(next)}`);
  }
  redirect(data.url);
}
