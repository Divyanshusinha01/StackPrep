/** Sign-in (Supabase Auth) only; repository access is granted separately through the GitHub App. */
export function primaryCta(signedIn: boolean) {
  return signedIn
    ? { href: "/workspaces", label: "Open workspaces" }
    : { href: "/login", label: "Sign in with GitHub" };
}

/** Brand halo for primary calls to action; `shadow-*` composes with the focus ring. */
export const CTA_GLOW =
  "shadow-[0_0_0_1px_oklch(1_0_0/0.12)_inset,0_10px_40px_-10px_var(--brand)] hover:shadow-[0_0_0_1px_oklch(1_0_0/0.18)_inset,0_12px_48px_-8px_var(--brand)] focus-visible:shadow-[0_0_0_1px_oklch(1_0_0/0.18)_inset,0_12px_48px_-8px_var(--brand)]";

export const SECTIONS = [
  { id: "how-it-works", step: "01", label: "Connect" },
  { id: "analysis", step: "02", label: "Analyze" },
  { id: "interview", step: "03", label: "Interview" },
  { id: "depth", step: "04", label: "Depth" },
  { id: "report", step: "05", label: "Report" },
  // Header nav shows this one from `lg` only: six links crowd out the CTA at `md`.
  { id: "your-key", step: "06", label: "Key", wideOnly: true },
] as const;

/** The order a new account is set up in; the OpenAI key comes before any repository. */
export const ONBOARDING_STEPS = ["Sign in with GitHub", "Add your OpenAI API key", "Connect a repository"] as const;
