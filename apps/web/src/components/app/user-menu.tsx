"use client";

import Link from "next/link";
import { ChevronDown, KeyRound, LogOut, Settings } from "lucide-react";
import { DropdownMenu } from "radix-ui";

function initials(name: string): string {
  const parts = name.replace(/@.*$/, "").split(/[\s._-]+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[1][0] : (parts[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

export function UserMenu({ name, email, keyAlert = false }: { name: string; email: string | null; keyAlert?: boolean }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        className="group inline-flex h-9 max-w-[14rem] items-center gap-2 rounded-md px-1.5 text-sm text-muted-foreground transition-colors focus-ring hover:bg-accent/50 hover:text-foreground data-[state=open]:bg-accent/50 data-[state=open]:text-foreground"
        aria-label={`Account menu for ${name}${keyAlert ? " (OpenAI key needs attention)" : ""}`}
      >
        <span
          aria-hidden
          className="relative grid size-7 shrink-0 place-items-center rounded-full bg-brand-muted text-[11px] font-semibold text-brand"
        >
          {initials(name)}
          {keyAlert ? (
            <span
              className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full border-2 border-background bg-warning"
              data-testid="openai-key-alert"
            />
          ) : null}
        </span>
        <span className="hidden truncate sm:inline" data-testid="current-user">
          {name}
        </span>
        <ChevronDown className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-180" aria-hidden />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="z-50 min-w-[14rem] rounded-lg border bg-popover p-1 text-sm text-popover-foreground shadow-lg data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0"
        >
          <div className="px-2.5 py-2">
            <p className="truncate font-medium">{name}</p>
            {email && email !== name ? <p className="truncate text-xs text-muted-foreground">{email}</p> : null}
          </div>
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          <DropdownMenu.Item asChild>
            <Link
              href="/settings"
              className="flex w-full cursor-default items-center gap-2 rounded-md px-2.5 py-2 text-left outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
            >
              {keyAlert ? (
                <KeyRound className="size-4 text-warning" aria-hidden />
              ) : (
                <Settings className="size-4 text-muted-foreground" aria-hidden />
              )}
              <span className="flex-1">Settings</span>
              {keyAlert ? <span className="text-xs text-warning">Key needs attention</span> : null}
            </Link>
          </DropdownMenu.Item>
          <form action="/auth/signout" method="post">
            <DropdownMenu.Item asChild>
              <button
                type="submit"
                className="flex w-full cursor-default items-center gap-2 rounded-md px-2.5 py-2 text-left outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
              >
                <LogOut className="size-4 text-muted-foreground" aria-hidden />
                Sign out
              </button>
            </DropdownMenu.Item>
          </form>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
