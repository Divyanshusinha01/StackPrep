import type { Metadata } from "next";
import Link from "next/link";
import { LegalLayout } from "@/components/legal/legal-layout";
import { CONTACT_URL, SECURITY_URL } from "@/lib/site";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "What StackPrep collects when you connect a repository and take a voice interview, what is stored, what is discarded, and how to delete it.",
  alternates: { canonical: "/privacy" },
};

const PROCESSORS = [
  ["Supabase", "Database, sign-in and backend functions. Stores your account, workspaces, transcripts and reports."],
  ["Vercel", "Hosts the web app and provides cookieless, aggregate page analytics."],
  ["OpenAI", "Runs the voice interviewer, transcribes your speech, analyzes camera frames and repository context, and writes reports."],
  ["Inngest", "Runs background jobs (repository analysis, interview planning, reports)."],
  ["GitHub", "Sign-in and read-only repository access through the StackPrep GitHub App."],
  ["Sentry", "Error monitoring, with personal data scrubbed before sending."],
] as const;

export default function PrivacyPage() {
  return (
    <LegalLayout title="Privacy Policy" updated="October 14, 2026">
      <p>
        StackPrep is an open-source project that interviews you, by voice, about a GitHub repository you
        choose. This page explains what data that involves. It is written to match how the product actually
        works; if something here is unclear, <a href={CONTACT_URL}>ask us</a>.
      </p>

      <h2>What we collect</h2>
      <h3>Your GitHub account</h3>
      <p>
        When you sign in with GitHub we receive your GitHub user id, username, display name, avatar and
        email address. We use them to identify your account and show who is signed in.
      </p>
      <h3>Repositories you connect</h3>
      <p>
        Repository access goes through the StackPrep GitHub App, which has <strong>read-only</strong>{" "}
        access to contents and metadata of the repositories you select during installation. For each
        workspace we read the repository at a pinned commit and store a derived analysis: the file
        structure, dependencies, code facts such as symbol names and call relationships, short code
        excerpts and AI-written summaries. Secrets such as API keys and passwords are scrubbed before
        analysis. We do not keep a persistent clone of your repository.
      </p>
      <h3>Interviews</h3>
      <ul>
        <li>
          <strong>Transcript.</strong> What you and the interviewer say is transcribed and stored, along
          with interview state, answer evaluations and the final report.
        </li>
        <li>
          <strong>Microphone audio.</strong> Audio is streamed to the AI provider for real-time speech
          processing and is <strong>not retained</strong>. We never store a recording.
        </li>
        <li>
          <strong>Camera.</strong> About every 10 seconds, one low-detail camera frame is sent to an AI
          vision model to check for integrity signals (for example, looking away from the screen). Frames
          are analyzed and <strong>discarded</strong>; only the detected signals and warnings are stored,
          never the images. Signals are not proof of misconduct.
        </li>
        <li>
          <strong>Usage records.</strong> We log AI usage (token and audio counts, cost) per interview to
          enforce the usage limit and control costs.
        </li>
      </ul>
      <h3>Analytics and errors</h3>
      <p>
        We use Vercel Web Analytics to count page views and a few product events (such as starting an
        interview). It is cookieless and aggregate, and event data never includes repository names, file
        paths or transcript content. Errors are reported to Sentry with personal data scrubbed. Sign-in
        uses essential cookies only; we do not use advertising or tracking cookies, so there is no cookie
        banner.
      </p>

      <h2>How we use it</h2>
      <p>
        Only to run the service: analyze your repository, conduct and transcribe the interview, monitor
        interview integrity, generate your report, enforce usage limits, and fix problems. We do not sell
        your data or use it for advertising.
      </p>

      <h2>Who processes it</h2>
      <p>StackPrep relies on these providers, each of which processes data on our behalf:</p>
      <ul>
        {PROCESSORS.map(([name, purpose]) => (
          <li key={name}>
            <strong>{name}.</strong> {purpose}
          </li>
        ))}
      </ul>
      <p>
        These providers may process data in the United States and other countries. Their own privacy terms
        apply to their handling of it.
      </p>

      <h2 id="retention">How long we keep it</h2>
      <p>
        Workspaces, repository analysis, transcripts and reports are kept until you delete them or ask us to
        delete your account. There is no automatic expiry yet.
      </p>

      <h2 id="deletion">Deleting your data</h2>
      <ul>
        <li>
          <strong>Interviews.</strong> You can delete an ended interview from your history. It disappears
          from your workspace, and its transcript and report are no longer accessible to you. A minimal
          record is kept so it still counts toward the 5-interviews-per-24-hours limit and keeps its
          interview number, and it can still inform the coverage of later interviews in that workspace.
        </li>
        <li>
          <strong>Repository access.</strong> You can revoke access at any time by uninstalling the
          StackPrep GitHub App, and revoke sign-in by removing the StackPrep authorization in your GitHub
          settings.
        </li>
        <li>
          <strong>Your whole account.</strong> There is no self-service account deletion yet. To have your
          account and all associated data (workspaces, analysis, transcripts, reports and integrity signals)
          permanently deleted, <a href={CONTACT_URL}>open a request on our issue tracker</a> with the title
          &ldquo;Data deletion request&rdquo; and your GitHub username only. Do not post anything else
          personal; we will confirm through GitHub once it is done.
        </li>
      </ul>

      <h2>Security</h2>
      <p>
        Data is protected with row-level security so only you can read your workspaces and interviews.
        Server credentials never reach your browser; the voice session uses a short-lived credential.
        Please report vulnerabilities privately through our <a href={SECURITY_URL}>security policy</a>.
      </p>

      <h2>Children</h2>
      <p>StackPrep is not intended for anyone under 16.</p>

      <h2>Changes</h2>
      <p>
        If we change how data is handled, we will update this page and its date. The source of this policy
        and of the product is public on GitHub.
      </p>

      <h2>Contact</h2>
      <p>
        Questions or requests: <a href={CONTACT_URL}>GitHub issues</a>. See also the{" "}
        <Link href="/terms">Terms of Service</Link>.
      </p>
    </LegalLayout>
  );
}
