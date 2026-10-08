import type { User } from "@supabase/supabase-js";
import Link from "next/link";
import { AppNav } from "@/components/app/app-nav";
import { Skeleton } from "@/components/app/skeleton";
import { UserMenu } from "@/components/app/user-menu";
import { Wordmark } from "@/components/landing/wordmark";

type AppShellProps = {
  /** Null while a route is loading; the account menu shows a placeholder. */
  user: User | null;
  children: React.ReactNode;
};

function displayName(user: User): string {
  const meta = user.user_metadata as Record<string, unknown>;
  for (const key of ["full_name", "name", "user_name", "preferred_username"]) {
    const value = meta[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return user.email ?? "Signed in";
}

export function AppShell({ user, children }: AppShellProps) {
  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#main"
        className="sr-only z-[80] rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-40 border-b bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70 print:hidden">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4 sm:h-16 sm:gap-6 sm:px-6">
          <Link href="/" aria-label="StackPrep home" className="focus-ring rounded-md">
            <Wordmark />
          </Link>
          <AppNav className="hidden sm:flex" />
          <div className="ml-auto">
            {user ? (
              <UserMenu name={displayName(user)} email={user.email ?? null} />
            ) : (
              <Skeleton className="size-7 rounded-full" />
            )}
          </div>
        </div>
        <AppNav className="mx-auto h-12 max-w-6xl border-t px-3 sm:hidden" />
      </header>
      <main
        id="main"
        tabIndex={-1}
        className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 outline-none motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1 motion-safe:duration-300 sm:px-6 sm:py-12"
      >
        {children}
      </main>
    </div>
  );
}
