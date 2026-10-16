import Link from "next/link";
import { CONTACT_URL, REPO_URL, SECURITY_URL } from "@/lib/site";
import { cn } from "@/lib/utils";
import { Wordmark } from "./wordmark";

const LINK = "focus-ring rounded-sm text-muted-foreground transition-colors hover:text-foreground";
const NEW_TAB = <span className="sr-only"> (opens in a new tab)</span>;

/** Legal and contact links shared by the landing page, legal pages and sign-in. */
export function FooterLinks({ className }: { className?: string }) {
  return (
    <nav aria-label="Footer" className={className}>
      <ul className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
        <li>
          <Link href="/privacy" className={LINK}>
            Privacy
          </Link>
        </li>
        <li>
          <Link href="/terms" className={LINK}>
            Terms
          </Link>
        </li>
        <li>
          <a href={REPO_URL} className={LINK} rel="noopener noreferrer" target="_blank">
            GitHub
            {NEW_TAB}
          </a>
        </li>
        <li>
          <a href={SECURITY_URL} className={LINK} rel="noopener noreferrer" target="_blank">
            Security
            {NEW_TAB}
          </a>
        </li>
        <li>
          <a href={CONTACT_URL} className={LINK} rel="noopener noreferrer" target="_blank">
            Contact
            {NEW_TAB}
          </a>
        </li>
      </ul>
    </nav>
  );
}

export function SiteFooter({ className }: { className?: string }) {
  return (
    <footer className={cn("border-t", className)}>
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-10 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-2">
          <Wordmark />
          <p className="max-w-sm text-sm text-muted-foreground">
            Voice-first technical interviews on the repository you choose.
          </p>
        </div>
        <div className="flex flex-col gap-3 sm:items-end">
          <FooterLinks />
          <p className="text-sm text-muted-foreground">© {new Date().getFullYear()} StackPrep</p>
        </div>
      </div>
    </footer>
  );
}
