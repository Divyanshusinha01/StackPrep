# Security policy

## Reporting a vulnerability

Please do not open a public issue for security problems.

Report vulnerabilities privately through GitHub: go to the [Security tab](https://github.com/Divyanshusinha01/StackPrep/security) and choose **Report a vulnerability**. Include the affected component (web app, an Edge Function, a migration), steps to reproduce, and the impact you expect.

You should get an acknowledgement within 7 days. Once a fix is released, the advisory will be published with credit, unless you ask to stay anonymous.

## Supported versions

Only the `main` branch and the current production deployment receive security fixes.

## Scope

In scope:

- The Next.js app in `apps/web`
- Supabase Edge Functions in `supabase/functions`
- Database schema, row-level security and SQL functions in `supabase/migrations`

Out of scope:

- Vulnerabilities in third-party services (Supabase, Vercel, OpenAI, Inngest, GitHub, Sentry); report those to the vendor
- Denial of service through volume alone, and findings from automated scanners without a demonstrated impact
- Missing hardening that does not lead to an exploitable issue

## Handling secrets

The repository contains no real credentials. Every `.env*` file except the `*.example` files is gitignored, and [`.gitleaks.toml`](.gitleaks.toml) lists the deliberately fake secrets used by the scrubber tests. If you find a real credential anywhere in the repository or its history, report it as described above.
