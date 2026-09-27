import { FinalCta } from "@/components/landing/final-cta";
import { GitHubWorkspace } from "@/components/landing/github-workspace";
import { Hero } from "@/components/landing/hero";
import { Interview } from "@/components/landing/interview";
import { InterviewReport } from "@/components/landing/interview-report";
import { RepositoryAnalysis } from "@/components/landing/repository-analysis";
import { SiteHeader, Wordmark } from "@/components/landing/site-header";
import { TechnicalDepth } from "@/components/landing/technical-depth";
import { MotionProvider } from "@/components/motion/motion-provider";

export default function Home() {
  return (
    <div id="top">
      <a
        href="#main"
        className="sr-only z-[60] rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Skip to content
      </a>
      <MotionProvider>
        <SiteHeader />
        <main id="main" className="overflow-x-clip">
          <Hero />
          <GitHubWorkspace />
          <RepositoryAnalysis />
          <Interview />
          <TechnicalDepth />
          <InterviewReport />
          <FinalCta />
        </main>
      </MotionProvider>
      <footer className="border-t">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-6 py-8 text-sm text-muted-foreground sm:flex-row">
          <Wordmark />
          <p>© {new Date().getFullYear()} StackPrep</p>
        </div>
      </footer>
    </div>
  );
}
