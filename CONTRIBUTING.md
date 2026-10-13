# Contributing to StackPrep

Thanks for your interest. Bug reports, fixes and focused improvements are welcome.

## Before you start

- Read [`PRD.md`](PRD.md), [`architecture.md`](architecture.md) and [`techstack.md`](techstack.md). They are the source of truth for product scope, system boundaries and allowed technologies.
- For anything larger than a small fix, open an issue first so the approach can be agreed before you write code.
- Security issues go through [`SECURITY.md`](SECURITY.md), not public issues.

## Local setup

Follow [Setup](README.md#setup) in the README. You need Node.js 24+, pnpm 9.15, Docker and Deno 2.x. The E2E suite needs no real credentials.

## Making a change

1. Branch from `main`.
2. Keep the change focused. Match the style, naming and comment density of the surrounding code.
3. Add or update tests at the right layer: Vitest for packages, Deno tests for Edge Functions, pgTAP for SQL, Playwright for user flows.
4. If you change the schema, add a migration under `supabase/migrations` and run `pnpm db:types`.
5. Run the checks locally:

   ```bash
   pnpm check          # typecheck, lint, unit and Deno tests, build
   pnpm test:db        # if you touched migrations or SQL functions
   pnpm test:e2e       # if you touched user-facing flows
   pnpm eval:replay    # if you touched prompts, retrieval or report generation
   ```

6. Never commit real secrets or `.env` files. Use the `*.example` files for new variables, and add them to the env tables in the README.

## Pull requests

- Describe what changed and why, and how you tested it. The PR template has a checklist.
- CI (`Check` and `E2E`) must be green before review.
- Keep commits readable; they become part of `main`'s history.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
