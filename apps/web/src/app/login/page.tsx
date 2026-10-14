import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { safeNextPath } from "@stackprep/shared";
import { Notice } from "@/components/app/notice";
import { SubmitButton } from "@/components/app/submit-button";
import { CTA_GLOW } from "@/components/landing/constants";
import { GitHubMark } from "@/components/landing/github-mark";
import { FooterLinks } from "@/components/landing/site-footer";
import { Wordmark } from "@/components/landing/wordmark";
import { getUser } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { signInWithGitHub } from "./actions";

export const metadata: Metadata = {
  title: "Sign in",
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
    <main className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden px-6 py-12">
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-grid mask-radial opacity-70" />
      <div className="surface-inset relative w-full max-w-md rounded-xl border border-border-strong/70 bg-panel/90 p-8 shadow-2xl">
        <div className="text-center">
          <Link href="/" aria-label="StackPrep home" className="focus-ring inline-flex rounded-md">
            <Wordmark />
          </Link>
          <h1 className="mt-6 font-display text-2xl font-semibold tracking-tight">Sign in to StackPrep</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Sign in with your GitHub account. You will choose which repositories StackPrep can read in a
            separate step.
          </p>
        </div>
        {error ? (
          <Notice tone="error" className="mt-5 text-left">
            {error}
          </Notice>
        ) : null}
        <form action={signInWithGitHub} className="mt-6">
          <input type="hidden" name="next" value={next} />
          <SubmitButton size="lg" pendingLabel="Redirecting to GitHub…" className={cn("h-11 w-full text-[15px]", CTA_GLOW)}>
            <GitHubMark className="size-4" />
            Continue with GitHub
          </SubmitButton>
        </form>
        <p className="mt-3 text-center text-xs leading-relaxed text-muted-foreground">
          By continuing you agree to the{" "}
          <Link href="/terms" className="focus-ring rounded-sm text-foreground/85 underline underline-offset-4 hover:text-foreground">
            Terms
          </Link>{" "}
          and{" "}
          <Link href="/privacy" className="focus-ring rounded-sm text-foreground/85 underline underline-offset-4 hover:text-foreground">
            Privacy Policy
          </Link>
          .
        </p>
        <dl className="mt-6 divide-y border-t pt-4 text-xs text-muted-foreground">
          <div className="flex items-center justify-between gap-4 py-2">
            <dt className="font-medium text-foreground/85">Repository access</dt>
            <dd className="text-right font-mono text-[11px]">Per-repo via GitHub App</dd>
          </div>
          <div className="flex items-center justify-between gap-4 py-2">
            <dt className="font-medium text-foreground/85">Permissions</dt>
            <dd className="text-right font-mono text-[11px]">Read-only contents &amp; metadata</dd>
          </div>
          <div className="flex items-center justify-between gap-4 py-2">
            <dt className="font-medium text-foreground/85">Source retention</dt>
            <dd className="text-right font-mono text-[11px]">No persistent repo clone</dd>
          </div>
          <div className="flex items-center justify-between gap-4 py-2">
            <dt className="font-medium text-foreground/85">Camera &amp; audio</dt>
            <dd className="text-right font-mono text-[11px]">Frames analyzed, never stored; no audio kept</dd>
          </div>
        </dl>
      </div>
      <FooterLinks className="relative mt-8 [&_ul]:justify-center" />
    </main>
  );
}
