import { env } from "@/env";

const vercelUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL;

/** Absolute origin, no trailing slash. Previews fall back to their Vercel URL, local dev to localhost. */
export const SITE_URL = (
  env.NEXT_PUBLIC_SITE_URL ?? (vercelUrl ? `https://${vercelUrl}` : "http://localhost:3000")
).replace(/\/+$/, "");

export const SITE_NAME = "StackPrep";

export const TITLE = "StackPrep · Turn your codebase into an interview";

export const DESCRIPTION =
  "Connect GitHub, pick a repository, and get interviewed by an AI that has read your code. Explain your architecture, defend your decisions, and get a detailed report. Runs on your own OpenAI API key.";

/** Next replaces, not merges, a parent's `openGraph`, so pages that set one spread this in. */
export const OPEN_GRAPH = {
  type: "website",
  siteName: SITE_NAME,
  title: TITLE,
  description: DESCRIPTION,
} as const;

export const REPO_URL = "https://github.com/Divyanshusinha01/StackPrep";

/** Public contact channel; there is no support email. */
export const CONTACT_URL = `${REPO_URL}/issues`;

export const SECURITY_URL = `${REPO_URL}/security`;
