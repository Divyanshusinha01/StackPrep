import { FinalCta } from "@/components/landing/final-cta";
import { GitHubWorkspace } from "@/components/landing/github-workspace";
import { Hero } from "@/components/landing/hero";
import { Interview } from "@/components/landing/interview";
import { InterviewReport } from "@/components/landing/interview-report";
import { RepositoryAnalysis } from "@/components/landing/repository-analysis";
import { ScrollSpine } from "@/components/landing/scroll-spine";
import { SiteHeader, Wordmark } from "@/components/landing/site-header";
import { TechnicalDepth } from "@/components/landing/technical-depth";
import { MotionProvider } from "@/components/motion/motion-provider";
import { getUser } from "@/lib/auth";

export default async function Home() {
  const signedIn = (await getUser()) !== null;
  return (
    <div id="top">
      <a
        href="#main"
        className="sr-only z-[60] rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Skip to content
      </a>
      <MotionProvider>
        <SiteHeader signedIn={signedIn} />
        <ScrollSpine />
        <main id="main" className="overflow-x-clip">
          <Hero signedIn={signedIn} />
          <GitHubWorkspace />
          <RepositoryAnalysis />
          <Interview />
          <TechnicalDepth />
          <InterviewReport />
          <FinalCta signedIn={signedIn} />
        </main>
      </MotionProvider>
      <footer className="border-t">
        <div className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-10 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-col gap-2">
            <Wordmark />
            <p className="max-w-sm text-sm text-muted-foreground">
              Voice-first technical interviews on the repository you choose.
            </p>
          </div>
          <p className="text-sm text-muted-foreground">© {new Date().getFullYear()} StackPrep</p>
        </div>
      </footer>
    </div>
  );
}
