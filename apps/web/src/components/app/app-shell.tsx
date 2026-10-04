import type { User } from "@supabase/supabase-js";
import Link from "next/link";
import { Wordmark } from "@/components/landing/wordmark";
import { Button } from "@/components/ui/button";

type AppShellProps = {
  user: User;
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
    <div className="flex min-h-screen flex-col">
      <header className="border-b">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-6">
          <Link href="/" className="rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
            <Wordmark />
          </Link>
          <nav aria-label="App" className="flex items-center gap-1 text-sm">
            <Link href="/workspaces" className="rounded-md px-2.5 py-1.5 text-muted-foreground hover:text-foreground">
              Workspaces
            </Link>
            <Link href="/interviews" className="rounded-md px-2.5 py-1.5 text-muted-foreground hover:text-foreground">
              Interviews
            </Link>
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <span className="text-sm text-muted-foreground" data-testid="current-user">
              {displayName(user)}
            </span>
            <form action="/auth/signout" method="post">
              <Button type="submit" variant="ghost" size="sm">
                Sign out
              </Button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-12">{children}</main>
    </div>
  );
}
