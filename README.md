# StackPrep

A voice-first technical interview about **your own GitHub repository**: connect a repo, talk through it with an AI interviewer that reads the code as you speak, and get a report that cites the files behind each finding.

[![Check](https://github.com/Divyanshusinha01/StackPrep/actions/workflows/check.yml/badge.svg)](https://github.com/Divyanshusinha01/StackPrep/actions/workflows/check.yml)
[![E2E](https://github.com/Divyanshusinha01/StackPrep/actions/workflows/e2e.yml/badge.svg)](https://github.com/Divyanshusinha01/StackPrep/actions/workflows/e2e.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Live demo:** [stackprep-eta.vercel.app](https://stackprep-eta.vercel.app)

![StackPrep landing page](docs/assets/landing.png)

| Interview | Report |
| --- | --- |
| ![Voice interview grounded in repository files](docs/assets/interview.png) | ![Evidence-linked interview report](docs/assets/report.png) |

## Overview

Many developers ship code they cannot fully explain, especially when it was written with AI help, and a résumé link to a repository proves nothing about understanding it. StackPrep interviews a candidate about one repository they choose. The interview checks:

- understanding of the codebase
- engineering judgement
- the ability to explain and defend technical decisions
- ownership of the code, including AI-assisted code

The interviewer uses the repository as evidence and adapts its questions as the session goes on. Each repository gets a permanent workspace that holds its interviews and their reports. See [`PRD.md`](PRD.md) for the full product definition.

## Key features

- **GitHub App repository access.** Public and private repositories, read at a pinned commit. Sign-in uses a separate GitHub OAuth App through Supabase Auth.
- **Background repository analysis.** Durable Inngest jobs handle indexing, deep analysis, embeddings and interview planning, which produces a coverage map of topics to ask about.
- **Realtime voice interview over WebRTC.** The browser talks to the OpenAI Realtime API directly. The model's tool calls (`search_repository`, `get_file`, `evaluate_answer`, `advance_interview`, `end_interview`) run on the backend.
- **Live transcript**, persisted turn by turn in Postgres, which is the canonical record.
- **Integrity monitoring.** One low-detail webcam frame every 10 s is checked by a vision model and then discarded; frames are never stored.
- **Pause, resume and reconnect.** The interview wraps up at 30 minutes of connected voice time with a hard stop at 35, and the voice session closes after 3 minutes without candidate speech.
- **Evidence-linked reports.** Generated after the interview, citing transcript evidence and repository file paths.
- **Push-driven re-indexing.** GitHub push webhooks keep a workspace's analysis in sync with the default branch.
- **Admin dashboard** (`/admin`), restricted to an allow-list of user ids and re-checked by the `admin` Edge Function.
- **AI usage and cost tracking.** Per-call token, audio and cost rows go to an `ai_usage` table.

## Architecture

```mermaid
flowchart LR
    Browser["Browser (Next.js app)"]
    Web["Next.js on Vercel"]
    Edge["Supabase Edge Functions"]
    DB[("Postgres + pgvector, RLS")]
    Auth["Supabase Auth (GitHub OAuth)"]
    Inngest["Inngest"]
    Realtime["OpenAI Realtime (WebRTC)"]
    OpenAI["OpenAI text, vision, embeddings"]
    GitHub["GitHub App + webhooks"]
    Sentry["Sentry"]

    Browser --> Web
    Browser -->|"HTTP commands, SSE events"| Edge
    Browser -->|"audio + tool calls, ephemeral credential"| Realtime
    Browser --> Auth
    Edge --> DB
    Edge -->|"send events"| Inngest
    Inngest -->|"invokes job steps"| Edge
    Edge -->|"mint credential, evaluate, embed"| OpenAI
    Edge -->|"mint credential"| Realtime
    Edge -->|"read files at pinned commit"| GitHub
    GitHub -->|"push webhooks"| Edge
    Web --> Sentry
    Edge --> Sentry
```

Request/response work runs in Supabase Edge Functions (`interviews`, `workspaces`, `repositories`, `github`, `github-webhooks`, `me`, `admin`, `health`). Long-running work runs as Inngest functions, served by the `inngest` Edge Function, which call GitHub and OpenAI and write results back to Postgres. Every OpenAI call uses the user's own API key, which they add on `/settings`; it is validated, stored encrypted (AES-256-GCM, master keys in function secrets), and decrypted only inside Edge Functions. There is no platform key, and the browser only receives a short-lived Realtime credential.

**Request flow**

1. **Select a repository.** The user signs in with GitHub, adds their OpenAI API key on `/settings` (`PUT /me/openai-key` validates it with OpenAI before storing it), installs the GitHub App, and picks a repository. A workspace is created at a pinned commit.
2. **Analysis.** The `workspaces` function sends `repository.analysis.requested`. Inngest then runs analysis, code indexing (the Tree-sitter call graph), deep analysis and memory embeddings.
3. **Interview.** Creating an interview (in `workspaces`) queues `interview.planning.requested`. When the plan is ready, `POST /interviews/:id/realtime/session` mints a Realtime credential. The browser connects over WebRTC and relays each tool call to `POST /interviews/:id/tool-calls`. Transcript turns and session events go to `POST /interviews/:id/events`, and the browser follows `GET /interviews/:id/events` over SSE.
4. **Report.** Ending the interview queues `interview.report.requested`. The job writes a learning report: a question-by-question review (the candidate's verbatim answer, an assessment derived from the live evaluation, an AI-generated reference and ideal answer, and improvement steps), concepts to learn with links found by OpenAI web search on the user's key, and a prioritized learning plan. The report is stored in the workspace and a `report_ready` event is pushed to the browser.

The full design is in [`architecture.md`](architecture.md).

## Tech stack

| Layer | Choice |
| --- | --- |
| Frontend | Next.js 16, React 19, Tailwind CSS 4, shadcn/ui, Framer Motion |
| Frontend hosting | Vercel |
| Backend | Supabase Edge Functions (Deno 2) |
| Database | Supabase Postgres 17 with pgvector and row-level security |
| Auth | Supabase Auth (GitHub OAuth) |
| Background jobs | Inngest |
| Voice | OpenAI Realtime API over WebRTC (default `gpt-realtime-2.1-mini`) |
| Text, vision, embeddings | OpenAI API on each user's own key; models set per task via `OPENAI_*_MODEL` env vars |
| Code parsing | Tree-sitter (`web-tree-sitter` WASM) in `packages/code-parser` |
| Validation | Zod 4 (shared between web and Edge Functions) |
| Testing | Vitest, Deno test, pgTAP, Playwright |
| Monitoring | Sentry (`@sentry/nextjs`, `@sentry/deno`) |
| Analytics | Vercel Web Analytics (`@vercel/analytics`), cookieless; enable it in the Vercel project |

The reasoning behind each choice is in [`techstack.md`](techstack.md).

## Engineering challenges solved

- **Server-side tools for a browser-held voice session.** The `interviews` function mints a Realtime client secret that lives for 60 seconds ([`openai-realtime.ts`](supabase/functions/_shared/realtime/openai-realtime.ts)). The browser forwards each tool call it receives over the data channel to the backend ([`realtime-tool-relay.ts`](apps/web/src/components/app/realtime-tool-relay.ts)). The tools ([`interviews/tools`](supabase/functions/interviews/tools)) run with server credentials and persist their results, so the model never touches GitHub or the database directly.
- **Reconnects that don't lose or duplicate transcript.** A single reducer ([`reconnect-machine.ts`](apps/web/src/components/app/reconnect-machine.ts)) owns every connection attempt, so a burst of drop signals leads to one reconnect. An ordered, persistent outbox ([`transcript-outbox.ts`](apps/web/src/components/app/transcript-outbox.ts)) gives each item a `client_event_id`, which makes retries idempotent and lets a session continue after a page refresh.
- **Resumable SSE with a polling fallback.** `GET /interviews/:id/events` ([`events.ts`](supabase/functions/interviews/events.ts)) streams status, persisted-turn and report events behind a composite `Last-Event-ID` cursor, reading under the caller's RLS. When the stream fails, the client ([`interview-event-stream.ts`](apps/web/src/components/app/interview-event-stream.ts)) falls back to 4-second polling ([`use-poll-while.ts`](apps/web/src/components/app/use-poll-while.ts)).
- **A multi-language call graph inside an Edge Function.** [`packages/code-parser`](packages/code-parser) loads Tree-sitter WASM grammars for TypeScript/TSX, JavaScript, Python, Java, Go, C and C++. It resolves imports and links symbols into a path-based cross-file call graph ([`inngest/code-index.ts`](supabase/functions/inngest/code-index.ts)).
- **Incremental re-indexing from pushes.** [`github-webhooks`](supabase/functions/github-webhooks/handler.ts) verifies each push signature and bumps a per-workspace push generation. [`push-sync.ts`](supabase/functions/inngest/push-sync.ts) follows the new head with backoff. A 10-minute cron reconciler ([`push-reconcile.ts`](supabase/functions/inngest/push-reconcile.ts)) re-emits pushes that were lost.
- **Interview state enforced by Postgres.** State transitions, tool-call idempotency, integrity signals and AI usage are written through SQL functions in [`supabase/migrations`](supabase/migrations), with RLS on user data ([`20261004060500_rls.sql`](supabase/migrations/20261004060500_rls.sql)). These are covered by pgTAP tests and a concurrency test against a real database ([`supabase/tests`](supabase/tests)).
- **Model quality checks with no API key in CI.** The eval harness ([`evals`](evals)) records model outputs once, then replays them deterministically in CI against an approved [`baseline.json`](evals/projects/stackprep/baseline.json). A k6 harness ([`loadtest`](loadtest)) measures the SSE path under load.

## Repository layout

```text
apps/web/              Next.js app (UI, Supabase SSR auth, admin page, Playwright E2E in e2e/)
packages/shared/       Zod schemas, API contracts, env schemas, generated database types
packages/code-parser/  Tree-sitter WASM parsing, import resolution, call graph extraction
supabase/functions/    Deno Edge Functions; _shared/ holds auth, AI, GitHub, analysis, realtime code
supabase/migrations/   31 SQL migrations (schema, RLS, SQL functions)
supabase/tests/        pgTAP tests (database/) and concurrency tests (concurrency/)
evals/                 Eval harness: core runner plus the StackPrep project, datasets and recordings
loadtest/              k6 SSE load test, decision criteria and committed results
.github/               CI (workflows/check.yml, workflows/e2e.yml), Dependabot, issue and PR templates
docs/assets/           README screenshots
```

## Prerequisites

- Node.js 24 or later and pnpm 9.15 (`corepack enable` picks up the pinned `packageManager`)
- Docker, for the local Supabase stack
- Deno 2.x, for Edge Function tests, evals and load tests
- For the full flow:
  - an OpenAI API key of your own, entered on `/settings` after signing in (it is not an env var)
  - a GitHub App, for repository access
  - a GitHub OAuth App, for sign-in
  - the Inngest Dev Server (started by `pnpm dev:inngest`), or an Inngest account in production
- Optional: a Sentry project

The Supabase CLI is installed as a dev dependency, so `pnpm exec supabase` works without a global install.

## Setup

```bash
pnpm install

# Env files (see "Environment variables" below)
cp supabase/.env.example supabase/.env
cp supabase/functions/.env.example supabase/functions/.env
cp apps/web/.env.example apps/web/.env.local

# Local Supabase stack (Postgres, Auth, Edge runtime) and schema
pnpm exec supabase start
pnpm db:reset

# In separate terminals
pnpm dev:functions   # Edge Functions at http://127.0.0.1:54321/functions/v1
pnpm dev:inngest     # Inngest Dev Server, pointed at the inngest function
pnpm dev             # Next.js at http://localhost:3000
```

Set `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` in `apps/web/.env.local` to the publishable key printed by `pnpm exec supabase status`.

**GitHub configuration.** There are two separate GitHub apps:

- **OAuth App (sign-in).** Set its callback URL to `<SUPABASE_URL>/auth/v1/callback` and put its credentials in `supabase/.env`.
- **GitHub App (repository access).** In its settings, turn on *Request user authorization (OAuth) during installation* and set the Callback URL to `<web origin>/github/callback`. Set its webhook secret to `GITHUB_APP_WEBHOOK_SECRET`. The private key must be PKCS#8; convert it with `openssl pkcs8 -topk8 -nocrypt -in app.pem -out app-pkcs8.pem` and store it on one line with `\n` escapes.

After changing the schema, regenerate the shared database types with `pnpm db:types`.

## Environment variables

Every variable is validated with Zod at startup (`packages/shared/src/env.ts`). Never commit real values; the `.env.example` files list every key.

### `apps/web/.env.local` (from `apps/web/.env.example`)

| Variable | Required | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | Supabase API URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Yes | Supabase publishable key |
| `NEXT_PUBLIC_SITE_URL` | Yes, for production | Public origin (no trailing slash) for canonical URLs, social images, `robots.txt` and the sitemap. A Vercel production build fails without it |
| `NEXT_PUBLIC_GITHUB_APP_SLUG` | Yes, for repository connection | GitHub App slug, used to build the install link |
| `ADMIN_USER_IDS` | No | Comma-separated Supabase Auth user UUIDs allowed to open `/admin` (server-only) |
| `NEXT_PUBLIC_SENTRY_DSN` | No | Sentry DSN; empty disables Sentry |
| `SENTRY_ORG`, `SENTRY_PROJECT`, `SENTRY_AUTH_TOKEN` | No | Build-time source map upload; all three are needed |

### `supabase/.env` (from `supabase/.env.example`)

| Variable | Required | Purpose |
| --- | --- | --- |
| `SUPABASE_AUTH_EXTERNAL_GITHUB_CLIENT_ID` | Yes, for sign-in | GitHub OAuth App client id, read by `config.toml` |
| `SUPABASE_AUTH_EXTERNAL_GITHUB_SECRET` | Yes, for sign-in | GitHub OAuth App secret |

In hosted Supabase, set these under Authentication > Providers > GitHub instead.

### `supabase/functions/.env` (from `supabase/functions/.env.example`)

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are injected by the Edge runtime; do not set them here.

| Variable | Required | Purpose |
| --- | --- | --- |
| `WEB_ORIGIN` | Yes | Origin of the web app; other origins are rejected |
| `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY` | Yes | Sending events and serving Inngest functions |
| `OPENAI_KEY_ENCRYPTION_KEYS` | Yes | Keyring that encrypts users' OpenAI keys: comma-separated `version:base64` pairs, each a 32-byte key from `openssl rand -base64 32`. Use a different keyring per environment and never remove a version that stored keys still use |
| `OPENAI_KEY_ENCRYPTION_ACTIVE_VERSION` | Yes | Keyring version used for new saves; must be listed in `OPENAI_KEY_ENCRYPTION_KEYS` |
| `OPENAI_PLANNING_MODEL`, `OPENAI_EVALUATION_MODEL`, `OPENAI_REPORT_MODEL`, `OPENAI_VISION_MODEL` | No (defaults) | Text and vision models per task |
| `OPENAI_REALTIME_MODEL`, `OPENAI_REALTIME_TRANSCRIPTION_MODEL` | No (defaults) | Voice model, and the candidate-speech transcription model (default `gpt-live-transcribe`), which runs in its own transcription-only WebRTC session |
| `OPENAI_EMBEDDING_MODEL` | No (default) | Must natively output 1536-dimensional vectors |
| `OPENAI_PLANNING_REASONING_EFFORT`, `OPENAI_EVALUATION_REASONING_EFFORT`, `OPENAI_REPORT_REASONING_EFFORT`, `OPENAI_VISION_REASONING_EFFORT` | No (defaults) | `default`, `none`, `minimal`, `low`, `medium` or `high` |
| `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY` | Yes | GitHub App credentials (PKCS#8 private key) |
| `GITHUB_APP_WEBHOOK_SECRET` | Yes | Verifies push webhook signatures |
| `ADMIN_USER_IDS` | No | Same allow-list as the web app, re-checked by `admin` |
| `SENTRY_DSN`, `SENTRY_ENVIRONMENT` | No | Sentry for Edge Functions; empty DSN disables it |
| `INNGEST_DEV`, `INNGEST_SERVE_HOST` | Local only | Point the SDK at the Inngest Dev Server on the host; never set in production |

For production, copy the file without the local-only block and run `supabase secrets set --env-file supabase/functions/.env.production`.

### E2E

- `supabase/functions/.env.e2e.example` holds dummy credentials only; E2E never reaches GitHub or OpenAI. Its test-only keyring matches `E2E_OPENAI_KEY_ENCRYPTION_KEYS`, which Playwright uses to seed encrypted dummy keys for test users.
- `apps/web/.env.e2e.example` is optional. Without it, Supabase keys are read from `supabase status`.

## Production checklist

Before and after each production deploy:

- **Vercel env vars:** `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_SITE_URL` (the build fails without it), `NEXT_PUBLIC_GITHUB_APP_SLUG`, `ADMIN_USER_IDS`, and optionally `NEXT_PUBLIC_SENTRY_DSN` plus the Sentry build variables.
- **Vercel Web Analytics:** enabled in the Vercel project (Analytics tab).
- **Supabase Auth URLs** (Authentication > URL Configuration): Site URL set to the production origin, and `<origin>/auth/callback` in Redirect URLs. `supabase/config.toml` only configures the local stack.
- **GitHub OAuth App (sign-in):** callback `<SUPABASE_URL>/auth/v1/callback`.
- **GitHub App:** Callback URL `<origin>/github/callback`; webhook URL `<SUPABASE_URL>/functions/v1/github-webhooks` with `GITHUB_APP_WEBHOOK_SECRET`.
- **Edge Function secrets** (`supabase secrets set`): `WEB_ORIGIN` equal to the production origin, `ADMIN_USER_IDS`, the Inngest keys, the OpenAI model variables and the production keyring (`OPENAI_KEY_ENCRYPTION_KEYS`, `OPENAI_KEY_ENCRYPTION_ACTIVE_VERSION`; keep a copy in a password manager), GitHub App credentials, and `SENTRY_DSN`/`SENTRY_ENVIRONMENT`. `OPENAI_API_KEY` must not be set.
- **Inngest:** app synced to `<SUPABASE_URL>/functions/v1/inngest` with production event and signing keys.
- **After deploy (smoke test):** `/status` reports the API as healthy; `/robots.txt` and `/sitemap.xml` return 200 with production URLs; the page source of `/` has an absolute, non-localhost `og:image` and canonical; response headers include `Content-Security-Policy-Report-Only` and `Cross-Origin-Opener-Policy`.
- **CSP:** watch Sentry for CSP reports from the report-only policy. Once a full interview (camera, microphone, WebRTC to OpenAI) produces none, promote the policy from `buildFullCsp` to the enforced `Content-Security-Policy` in `apps/web/next.config.ts`.

### Data deletion requests

Users request full deletion through GitHub issues, as described on `/privacy`. Confirm the requester controls the GitHub account, then delete the user in Supabase (Authentication > Users > Delete user). Every user table cascades from `auth.users`; see [Data deletion](architecture.md#data-deletion). Close the issue once done.

## Development commands

All commands run from the repository root.

| Command | What it does |
| --- | --- |
| `pnpm dev` | Next.js dev server |
| `pnpm dev:functions` | Serve Edge Functions locally with `supabase/functions/.env` |
| `pnpm dev:inngest` | Inngest Dev Server targeting the local `inngest` function |
| `pnpm build` | Build all workspace packages |
| `pnpm lint` / `pnpm lint:functions` / `pnpm lint:evals` | ESLint for packages; `deno lint` for functions and evals |
| `pnpm typecheck` / `pnpm typecheck:functions` / `pnpm typecheck:evals` | `tsc` for packages; `deno check` for functions and evals |
| `pnpm db:reset` | Recreate the local database from migrations |
| `pnpm db:types` | Regenerate `packages/shared/src/database.types.ts` |
| `pnpm check` | Typecheck, lint, unit tests, Deno tests and build (what CI runs) |
| `pnpm eval` | Run evals, recording live model calls (needs your own `OPENAI_API_KEY` in the local shell; developer tooling only, never a deployed secret) |
| `pnpm eval:replay` | Replay committed recordings offline and compare with the baseline |
| `pnpm eval:verify` | Check datasets, corpora and recordings against `pins.json` |

## Testing

| Layer | Command | Notes |
| --- | --- | --- |
| Unit (Vitest) | `pnpm test` | `apps/web`, `packages/shared`, `packages/code-parser` |
| Edge Functions (Deno) | `pnpm test:functions` | Handlers, Inngest jobs, analysis, auth, AI provider |
| Evals (Deno) | `pnpm test:evals` | Tests for the eval harness itself |
| Database (pgTAP) | `pnpm test:db` | 22 test files: RLS, interview state, tool calls, reports, AI usage, code index, push sync, OpenAI credentials |
| Concurrency | `pnpm test:db:concurrency` | Concurrent interview operations against a real database; set `SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres` |
| E2E (Playwright) | `pnpm e2e:install`, `pnpm e2e:stack:up`, then `pnpm test:e2e` | Chromium against the local Supabase stack |

The E2E suite (`apps/web/e2e`) needs no real credentials:

- `fake-realtime.ts` replaces the OpenAI Realtime connection.
- `fake-inngest.ts` accepts events without running jobs; tests seed job outcomes directly.
- `network-guard.ts` blocks and records any browser request to OpenAI or GitHub, failing the test.

Specs cover app loading, workspaces, the interview, ending and deleting interviews, and reports. `pnpm test:e2e:ui` opens the Playwright UI, and `pnpm e2e:stack:down` stops the stack.

## CI

Both workflows use Node 24 with pnpm, and neither needs repository secrets.

- **[`check.yml`](.github/workflows/check.yml)** runs on pushes and pull requests to `main`, and manually.
  - The `pnpm check` job sets up Deno 2.x and runs `pnpm check` with placeholder Supabase env values. It then runs `pnpm eval:verify` and `pnpm eval:replay`, which make no network calls and need no OpenAI key.
  - The `Database tests` job starts a Postgres-only Supabase stack and checks that every migration was applied. It then runs `pnpm test:db` and `pnpm test:db:concurrency`.
- **[`e2e.yml`](.github/workflows/e2e.yml)** runs on any pull request, and on pushes to `main`, that touches the web app, shared packages, `supabase/`, `package.json` or the lockfile. It can also be run manually.
  - It starts the local Supabase stack and serves Edge Functions with the dummy `.env.e2e.example`.
  - It runs Playwright against a production build.
  - It uploads the Playwright report and test results, plus the Edge Functions log on failure, kept for 14 days.

## Evals and load testing

**Evals.** `evals/core` is a generic runner for recording, replaying, baselines, pins and statistics. `evals/projects/stackprep` defines suites for:

- retrieval
- citations
- support (whether report claims are backed by evidence)
- consistency of answer scoring
- contradiction detection

The suites run over a synthetic corpus and a snapshot of this repository. `pnpm eval` records live model outputs. CI replays them twice and fails on any baseline regression, replay miss or non-identical second replay.

**Load testing.** `loadtest/` drives concurrent interviews against `GET /interviews/:id/events` with k6 on the local Docker stack. The criteria are in `loadtest/decision-criteria.md`, and the tasks (`baseline`, `summarize`, and others) are in `loadtest/deno.json`. In the committed baseline ([`summary.md`](loadtest/results/sse-baseline/summary.md)), the first breach was at **10** concurrent interviews: the median error rate was 1.37%, against a 1% threshold. Those are local Docker numbers, so they are only useful for comparing runs, not as production capacity.

## Documentation

- [`PRD.md`](PRD.md): product goals, flows, features and acceptance criteria
- [`architecture.md`](architecture.md): system design, data flow, interview state and security
- [`techstack.md`](techstack.md): technology choices and AI cost targets

## Contributing and security

Contributions are welcome; see [`CONTRIBUTING.md`](CONTRIBUTING.md) for setup, checks and PR expectations. Please report vulnerabilities privately as described in [`SECURITY.md`](SECURITY.md), not in public issues.

## Status and license

StackPrep is under active development, and some designs in `PRD.md` and the architecture doc may be ahead of the code.

Released under the [MIT License](LICENSE).
