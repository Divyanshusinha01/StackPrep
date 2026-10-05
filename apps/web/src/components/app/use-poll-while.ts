"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

const POLL_INTERVAL_MS = 4000;

/** Re-renders the server page while `active`; progress always comes from persisted job state. */
export function usePollWhile(active: boolean) {
  const router = useRouter();
  useEffect(() => {
    if (!active) {
      return;
    }
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        router.refresh();
      }
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [active, router]);
}
