import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { safeNextPath } from "@stackprep/shared";
import { CTA_GLOW } from "@/components/landing/constants";
import { GitHubMark } from "@/components/landing/github-mark";
import { Wordmark } from "@/components/landing/wordmark";
import { Button } from "@/components/ui/button";
import { getUser } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { signInWithGitHub } from "./actions";

export const metadata: Metadata = {
  title: "Sign in · StackPrep",
  robots: { index: false },
};

const ERRORS: Record<string, string> = {
  oauth: "Could not start GitHub sign-in. Please try again.",
  callback: "GitHub sign-in did not complete. Please try again.",
  origin: "Sign-in request was rejected. Please try again.",
};

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const params = await searchParams;
  const next = safeNextPath(typeof params.next === "string" ? params.next : null);
  const errorKey = typeof params.error === "string" ? params.error : null;
  const error = errorKey ? (ERRORS[errorKey] ?? ERRORS.callback) : null;

  if (await getUser()) {
    redirect(next);
  }

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden px-6">
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-grid mask-radial opacity-70" />
      <div className="relative w-full max-w-sm rounded-xl border bg-panel/80 p-8 text-center">
        <Link href="/" className="inline-flex rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
          <Wordmark />
        </Link>
        <h1 className="mt-6 font-display text-2xl font-semibold tracking-tight">Sign in to StackPrep</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Sign in with your GitHub account. You will choose which repositories StackPrep can read in a
          separate step.
        </p>
        {error ? (
          <p role="alert" className="mt-4 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {error}
          </p>
        ) : null}
        <form action={signInWithGitHub} className="mt-6">
          <input type="hidden" name="next" value={next} />
          <Button type="submit" size="lg" className={cn("h-11 w-full text-[15px]", CTA_GLOW)}>
            <GitHubMark className="size-4" />
            Continue with GitHub
          </Button>
        </form>
      </div>
    </main>
  );
}
