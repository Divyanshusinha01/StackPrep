import Link from "next/link";
import { SiteFooter } from "@/components/landing/site-footer";
import { Wordmark } from "@/components/landing/wordmark";

const PROSE = [
  "text-[15px] leading-relaxed text-muted-foreground",
  "[&_h2]:mt-10 [&_h2]:font-display [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:tracking-tight [&_h2]:text-foreground",
  "[&_h3]:mt-6 [&_h3]:font-medium [&_h3]:text-foreground",
  "[&_p]:mt-3 [&_ul]:mt-3 [&_ul]:list-disc [&_ul]:space-y-1.5 [&_ul]:pl-5",
  "[&_strong]:font-medium [&_strong]:text-foreground",
  "[&_a]:text-brand [&_a]:underline [&_a]:underline-offset-4 [&_a:hover]:text-foreground",
].join(" ");

export function LegalLayout({
  title,
  updated,
  children,
}: {
  title: string;
  /** Human-readable date of the last material change. */
  updated: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#main"
        className="sr-only z-[60] rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Skip to content
      </a>
      <header className="border-b">
        <div className="mx-auto flex h-16 max-w-3xl items-center px-6">
          <Link href="/" aria-label="StackPrep home" className="focus-ring rounded-md">
            <Wordmark />
          </Link>
        </div>
      </header>
      <main id="main" className="mx-auto w-full max-w-3xl flex-1 px-6 py-12 sm:py-16">
        <h1 className="font-display text-3xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-2 font-mono text-xs text-muted-foreground">Last updated {updated}</p>
        <div className={PROSE}>{children}</div>
      </main>
      <SiteFooter />
    </div>
  );
}
