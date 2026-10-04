import { type NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  const { origin } = request.nextUrl;
  if (request.headers.get("origin") !== origin) {
    return NextResponse.json({ error: "Origin not allowed" }, { status: 403 });
  }

  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  return NextResponse.redirect(new URL("/", origin), { status: 303 });
}
