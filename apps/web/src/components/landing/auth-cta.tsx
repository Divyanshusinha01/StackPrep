"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { type CtaLocation, track } from "@/lib/analytics";
import { cn } from "@/lib/utils";
import { CTA_GLOW, primaryCta } from "./constants";
import { GitHubMark } from "./github-mark";

const SignedInContext = createContext(false);

/**
 * Signed-in state for the static landing page, read from the browser session after hydration.
 * It only picks the CTA label and link; the destination still authorizes on the server.
 */
export function AuthStateProvider({ children }: { children: React.ReactNode }) {
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    let active = true;
    let unsubscribe = () => {};
    // Loaded after first paint so the Supabase client stays out of the landing page's critical bundle.
    void import("@/lib/supabase/client").then(async ({ createSupabaseBrowserClient }) => {
      if (!active) return;
      const supabase = createSupabaseBrowserClient();
      const { data } = supabase.auth.onAuthStateChange((_event, session) => setSignedIn(session !== null));
      unsubscribe = () => data.subscription.unsubscribe();
      const { data: current } = await supabase.auth.getSession();
      if (active) setSignedIn(current.session !== null);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  return <SignedInContext.Provider value={signedIn}>{children}</SignedInContext.Provider>;
}

export function useLandingCta(location: CtaLocation) {
  const signedIn = useContext(SignedInContext);
  return {
    ...primaryCta(signedIn),
    onClick: () => track("cta_click", { location, signed_in: signedIn }),
  };
}

/** The primary "Sign in with GitHub" / "Open workspace" button. */
export function AuthCta({
  location,
  size,
  className,
  iconClassName = "size-4",
}: {
  location: CtaLocation;
  size?: React.ComponentProps<typeof Button>["size"];
  className?: string;
  iconClassName?: string;
}) {
  const cta = useLandingCta(location);
  return (
    <Button asChild size={size} className={cn(CTA_GLOW, className)}>
      <a href={cta.href} onClick={cta.onClick}>
        <GitHubMark className={iconClassName} />
        {cta.label}
      </a>
    </Button>
  );
}
