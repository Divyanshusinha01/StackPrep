import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { shareTokenSchema } from "@stackprep/shared";
import { Notice } from "@/components/app/notice";
import { PrintButton } from "@/components/app/print-button";
import { ReportToc } from "@/components/app/report-toc";
import { ReportView, reportSections } from "@/components/app/report-view";
import { Wordmark } from "@/components/landing/wordmark";
import { Button } from "@/components/ui/button";
import { getSharedReport } from "@/lib/api";

// A shared report is a capability URL: keep it out of search, and out of Referer headers.
export const metadata: Metadata = {
  title: "Shared interview report",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

const dateFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" });

/** Read-only public view of one report, reached through an unguessable link. No sign-in, no transcript. */
export default async function SharedReportPage({ params }: PageProps<"/r/[token]">) {
  const { token } = await params;
  if (!shareTokenSchema.safeParse(token).success) {
    notFound();
  }
  const result = await getSharedReport(token);
  if (!result.ok) {
    if (result.code === "not_found") {
      notFound();
    }
    return (
      <main id="main" className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
        <Notice tone="error" className="mt-0">
          <span className="min-w-0 flex-1">Could not load this report.</span>
          <Button asChild variant="outline" size="sm">
            <Link href={`/r/${token}`}>Reload</Link>
          </Button>
        </Notice>
      </main>
    );
  }
  const { report, repository, interview_number: number, generated_at: generatedAt } = result.data;

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-border/80 print:hidden">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4 sm:h-16 sm:px-6">
          <Link href="/" aria-label="StackPrep home" className="focus-ring rounded-md">
            <Wordmark />
          </Link>
          <PrintButton label="Save as PDF" />
        </div>
      </header>
      <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6 sm:py-10">
        <div className="mb-8 border-b border-border/70 pb-6 print:pb-4">
          <p className="text-xs font-medium tracking-wide text-muted-foreground">Shared report · read-only</p>
          <h1 className="mt-2 font-display text-2xl font-semibold tracking-tight sm:text-[1.75rem]">
            Interview {number} report
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {repository ? <span className="font-mono">{repository}</span> : "A private repository"}
            {" · "}Generated {dateFormat.format(new Date(generatedAt))} UTC
          </p>
        </div>
        <div className="lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-12">
          <aside className="mb-8 lg:mb-0 print:hidden">
            <div className="lg:sticky lg:top-8">
              <ReportToc items={[...reportSections(report)]} />
            </div>
          </aside>
          <div className="min-w-0">
            <ReportView report={report} />
          </div>
        </div>
      </main>
    </div>
  );
}
