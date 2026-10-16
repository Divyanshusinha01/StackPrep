import type { Metadata } from "next";
import { AuthStateProvider } from "@/components/landing/auth-cta";
import { BringYourOwnKey } from "@/components/landing/bring-your-own-key";
import { FinalCta } from "@/components/landing/final-cta";
import { GitHubWorkspace } from "@/components/landing/github-workspace";
import { Hero } from "@/components/landing/hero";
import { Interview } from "@/components/landing/interview";
import { InterviewReport } from "@/components/landing/interview-report";
import { RepositoryAnalysis } from "@/components/landing/repository-analysis";
import { ScrollSpine } from "@/components/landing/scroll-spine";
import { SiteFooter } from "@/components/landing/site-footer";
import { SiteHeader } from "@/components/landing/site-header";
import { TechnicalDepth } from "@/components/landing/technical-depth";
import { ActiveSectionProvider } from "@/components/landing/use-active-section";
import { MotionProvider } from "@/components/motion/motion-provider";
import { DESCRIPTION, OPEN_GRAPH, SITE_NAME, SITE_URL } from "@/lib/site";

export const metadata: Metadata = {
  alternates: { canonical: "/" },
  openGraph: { ...OPEN_GRAPH, url: "/" },
};

const JSON_LD = {
  "@context": "https://schema.org",
  "@type": "WebApplication",
  name: SITE_NAME,
  description: DESCRIPTION,
  url: SITE_URL,
  applicationCategory: "DeveloperApplication",
  operatingSystem: "Web",
};

/** Static: the signed-in CTA state is resolved in the browser so the page can be served from the CDN. */
export default function Home() {
  return (
    <div id="top">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD).replace(/</g, "\\u003c") }}
      />
      <a
        href="#main"
        className="sr-only z-[90] rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Skip to content
      </a>
      <AuthStateProvider>
        <MotionProvider>
          <ActiveSectionProvider>
            <SiteHeader />
            <ScrollSpine />
            <main id="main" className="overflow-x-clip">
              <Hero />
              <GitHubWorkspace />
              <RepositoryAnalysis />
              <Interview />
              <TechnicalDepth />
              <InterviewReport />
              <BringYourOwnKey />
              <FinalCta />
            </main>
          </ActiveSectionProvider>
        </MotionProvider>
      </AuthStateProvider>
      <SiteFooter />
    </div>
  );
}
