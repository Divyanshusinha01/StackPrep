import { withSentryConfig } from "@sentry/nextjs/config";
import type { NextConfig } from "next";
import "./src/env";
import { buildFullCsp, ENFORCED_CSP } from "./src/lib/csp";

// The full policy is report-only until production reports are clean; then it replaces ENFORCED_CSP.
const fullCsp = buildFullCsp({
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
  sentryDsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  dev: process.env.NODE_ENV === "development",
});

const securityHeaders = [
  { key: "Content-Security-Policy", value: ENFORCED_CSP },
  { key: "Content-Security-Policy-Report-Only", value: fullCsp },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(self), microphone=(self), display-capture=(), geolocation=(), payment=(), usb=()",
  },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  agentRules: false,
  transpilePackages: ["@stackprep/shared"],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  async rewrites() {
    // Browsers and crawlers request /favicon.ico regardless of the <link rel="icon"> tags.
    return [{ source: "/favicon.ico", destination: "/icon.svg" }];
  },
};

const sentryOrg = process.env.SENTRY_ORG || undefined;
const sentryProject = process.env.SENTRY_PROJECT || undefined;
const sentryAuthToken = process.env.SENTRY_AUTH_TOKEN || undefined;

export default withSentryConfig(nextConfig, {
  org: sentryOrg,
  project: sentryProject,
  authToken: sentryAuthToken,
  silent: !process.env.CI,
  telemetry: false,
  sourcemaps: { disable: !(sentryOrg && sentryProject && sentryAuthToken) },
});
