import { withSentryConfig } from "@sentry/nextjs/config";
import type { NextConfig } from "next";
import "./src/env";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  agentRules: false,
  transpilePackages: ["@stackprep/shared"],
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
