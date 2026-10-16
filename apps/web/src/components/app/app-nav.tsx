"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/workspaces", label: "Workspaces" },
  { href: "/interviews", label: "Interviews" },
] as const;

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AppNav({ className }: { className?: string }) {
  const pathname = usePathname();
  return (
    <nav aria-label="App" className={cn("flex items-center gap-1.5 text-sm", className)}>
      {LINKS.map(({ href, label }) => {
        const active = isActive(pathname, href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "focus-ring relative inline-flex h-9 items-center rounded-md px-3 font-medium transition-colors",
              active
                ? "bg-brand-muted/70 text-foreground after:absolute after:inset-x-2.5 after:-bottom-[6px] after:h-[2px] after:rounded-full after:bg-brand sm:after:-bottom-[13px]"
                : "text-muted-foreground hover:bg-panel-raised/70 hover:text-foreground",
            )}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
