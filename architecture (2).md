# StackPrep Architecture

## 1. Overview

StackPrep is a repository-based technical interview platform.

Core flow:

```text
User
  ↓
GitHub Connect
  ↓
Select Repository
  ↓
Repository Workspace
  ├── Interview
  │    ├── Interview Plan
  │    ├── Dynamic Questions
  │    └── Answers / Evaluation
  │
  └── Interview Report
```

The system is split into a Next.js frontend (Vercel), a Supabase Edge Functions API, Supabase (PostgreSQL + pgvector, Auth, Storage), Inngest background jobs, a GitHub App integration, and an OpenAI-backed interview engine.

---

## 2. Architecture

```text
                 ┌─────────────────────┐
                 │  Next.js (Vercel)   │
                 └──────────┬──────────┘
                            │ HTTPS
                            ▼
                 ┌─────────────────────┐
                 │   Supabase Edge     │
                 │   Functions (API)   │
                 └──────┬───────┬──────┘
                        │       │ events
              ┌─────────┘       └─────────┐
              ▼                           ▼
     ┌─────────────────┐         ┌─────────────────┐
     │    Supabase     │         │     Inngest     │
     │ Postgres +      │         │ Background jobs │
     │ pgvector, Auth, │         └────────┬────────┘
     │ Storage         │                  │
     └─────────────────┘                  ▼
              ▲               ┌───────────────────────┐
              │               │ GitHub App /          │
              │               │ Tree-sitter / OpenAI  │
              │               └───────────┬───────────┘
              └───────────────────────────┘
```

Request/response work runs in Supabase Edge Functions. Long-running work (indexing, analysis, report generation) runs as Inngest functions, which call GitHub, Tree-sitter, and OpenAI and persist results back to Supabase.

---

## 3. Components

### Frontend — Next.js

Responsibilities:

- Authentication
- GitHub connection
- Repository selection
- Workspace UI
- Interview interface
- Interview report UI

The frontend communicates with the backend through the API. Business logic and secrets remain server-side.

### Backend — Supabase Edge Functions

Serverless TypeScript functions hosted on Supabase.

Responsibilities:

- Authentication and authorization
- GitHub integration
- Repository metadata
- Workspace management
- Interview orchestration
- AI requests
- Enqueuing background jobs (Inngest events)
- Persistence

The backend is the primary application boundary.

### Database — Supabase PostgreSQL

Stores persistent application state:

- Users
- GitHub accounts/connections
- Repositories
- Workspaces
- Interviews
- Interview questions
- Answers
- Evaluations
- Reports

Repository source code itself should not be treated as primary database data.

### Auth & Storage — Supabase Auth, Supabase Storage

Supabase Auth handles user authentication. Supabase Storage holds file artifacts (e.g. generated reports, uploaded media).

### Background Jobs — Inngest

Durable, event-driven jobs for repository indexing, analysis, and report generation. See [Background Processing](#11-background-processing).

### GitHub — GitHub App

Used to:

- Authenticate/connect users
- List accessible repositories
- Read repository metadata
- Read relevant source files during analysis

GitHub credentials/tokens are never exposed to the browser.

### AI Engine — OpenAI API

Responsible for:

1. Repository understanding
2. Interview coverage planning
3. Dynamic question generation
4. Answer evaluation
5. Report generation

AI output is persisted where it becomes part of the interview record.

---

## 4. Workspace Model

A workspace represents the user's StackPrep context for a repository.

```text
Workspace
├── Repository
├── Repository Context
├── Interview Plan
├── Interview Sessions
└── Interview Reports
```

A repository can have multiple interview sessions.

The workspace is the primary UI boundary after repository selection.

---

## 5. Interview Architecture

The interview uses a hybrid approach.

### Phase 1 — Planning

Before the interview, StackPrep creates a high-level coverage plan based on the repository.

Example:

```text
Architecture
├── System design
├── Backend
├── Database
├── Security
└── Testing
```

### Phase 2 — Dynamic Interview

Questions are generated during the interview based on:

- Repository context
- Interview plan
- Previous questions
- Candidate answers
- Detected strengths/gaps

```text
Question
   ↓
Candidate Answer
   ↓
Evaluate
   ↓
Update Interview Context
   ↓
Generate Next Question
```

The interview is stateful and adaptive rather than a static questionnaire.

#### Transport

Use HTTP for commands and state changes. Use **Server-Sent Events (SSE)** when streaming AI-generated questions or evaluations to the frontend.

WebSockets are not required initially because the interaction is primarily server-to-client streaming.

### Phase 3 — Report

After completion:

```text
Interview Data
      ↓
Evaluation
      ↓
Report Generation
      ↓
Workspace → Interview Report
```

---

## 6. Repository Context

StackPrep should avoid sending an entire repository to the AI on every request.

Each repository analysis is pinned to a specific Git commit SHA.

Repository processing should produce a compact context containing:

- Repository structure
- Important files
- Dependencies
- Frameworks
- Architecture signals
- Relevant code excerpts
- Configuration information

Initial indexing uses file-tree analysis, metadata/dependency analysis, and lightweight code parsing.

Semantic/vector retrieval can be introduced later with `pgvector` if repository scale requires it.

```text
Repository
    ↓
Commit SHA
    ↓
Index
    ↓
Repository Context
    ↓
Interview
```

The interview always references the indexed commit used to create its context.

---

## 7. API Structure

Use resource-oriented API boundaries.

```text
/auth
/github
/repositories
/workspaces
/interviews
/questions
/reports
```

Example:

```text
POST   /github/connect
GET    /repositories
POST   /workspaces
GET    /workspaces/:id
POST   /workspaces/:id/interviews
POST   /interviews/:id/answers
GET    /interviews/:id/report
```

The frontend should never directly call GitHub or the AI provider for privileged operations.

---

## 8. Data Flow

### Repository Selection

```text
User
 → Next.js
 → Supabase Edge Functions
 → GitHub App
 → Supabase PostgreSQL
 → Inngest (repository indexing)
 → Workspace
```

### Interview

```text
Workspace
 → Interview API
 → Repository Context
 → AI Engine
 → Question
 → User Answer
 → AI Evaluation
 → PostgreSQL
```

### Report

```text
Interview Data
 → Evaluation
 → AI Report Generation
 → PostgreSQL
 → Workspace
```

---

## 9. Interview State & Auditability

Interview state must be reproducible.

Store:

- Current interview state for fast reads
- Immutable interview message/event history
- Questions
- Answers
- Evaluations
- Repository commit SHA

```text
Interview
├── repository_commit_sha
├── current_state
└── message_history
     ├── question
     ├── answer
     ├── evaluation
     └── system events
```

The message history is append-only. Current state may be updated as the interview progresses.

This preserves the exact context used to generate the final report.

---

## 10. Authentication & Authorization

Authentication identifies the user.

Authorization verifies ownership for every workspace, repository, and interview request.

Core rule:

```text
Request
 → Authenticate user
 → Resolve resource
 → Verify ownership/access
 → Execute operation
```

Never rely on frontend route protection alone.

---

## 11. Background Processing

Long-running operations should not block normal API requests.

Use background jobs for:

- Repository indexing
- Large repository analysis
- Report generation
- Other expensive AI operations

### Implementation — Inngest

Background jobs run on **Inngest**. Supabase Edge Functions only send events; they do not execute long-running work.

```text
Supabase Edge Function
 ↓ (send event)
Inngest
 ↓
Inngest function (durable steps)
 ↓
GitHub App / Tree-sitter / OpenAI
 ↓
Supabase PostgreSQL / Storage
```

Inngest provides retries, step-level durability, concurrency control, and scheduling, so no custom jobs table or polling worker is required.

Inngest functions are served by a dedicated `inngest` Supabase Edge Function (`{SUPABASE_URL}/functions/v1/inngest`), which Inngest calls to execute each step. No separate worker host is deployed.

Job status that the UI needs (e.g. indexing progress, report readiness) is persisted to Supabase PostgreSQL by the Inngest function.

The application should expose a job abstraction (e.g. `enqueue(type, payload)`) so domain code does not depend directly on Inngest.

Do not rely on in-process background tasks for critical work.

---

## 12. Security

Key requirements:

- Encrypt sensitive GitHub credentials/tokens
- Keep secrets server-side
- Validate all API input
- Enforce workspace ownership
- Apply GitHub permission scopes minimally
- Rate-limit expensive AI endpoints
- Sanitize repository-derived content
- Scrub secrets before AI ingestion, including API keys, access tokens, private keys, passwords, and `.env` values
- Never pass raw secret-bearing files into the AI context
- Treat repository files as untrusted input
- Prevent prompt injection from repository content from overriding system instructions

---

## 13. Deployment

```text
Next.js / Vercel
       ↓
Supabase Edge Functions
       ↓
 ┌─────┴─────┐
 ▼           ▼
Supabase    Inngest
             ↓
      GitHub / Tree-sitter / OpenAI
             ↓
          Supabase
```

| Concern         | Platform                |
| --------------- | ----------------------- |
| Frontend        | Vercel (Next.js)        |
| Backend / API   | Supabase Edge Functions |
| Database        | Supabase PostgreSQL     |
| Vector search   | pgvector                |
| Authentication  | Supabase Auth           |
| File storage    | Supabase Storage        |
| Background jobs | Inngest                 |
| AI              | OpenAI API              |
| Repo access     | GitHub App              |

Frontend, Edge Functions, and Inngest functions are independently deployable.

Environment-specific configuration is managed through environment variables.

### Environment variables

Each integration has its own Zod schema in `@stackprep/shared` (`packages/shared/src/env.ts`) and is validated only where that integration is used. Only the core Supabase variables are required at boot. Secrets live only in the Edge Functions environment; the web app receives only `NEXT_PUBLIC_*` values plus Sentry build-time variables.

**Vercel (Next.js)** — template in `apps/web/.env.example`

| Schema                  | Variables                                                                    |
| ----------------------- | ---------------------------------------------------------------------------- |
| `webEnvSchema` (required) | `NODE_ENV`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` |
| `webSentryEnvSchema`    | `NEXT_PUBLIC_SENTRY_DSN`; build-time `SENTRY_ORG`, `SENTRY_PROJECT`, `SENTRY_AUTH_TOKEN` |
| `webGithubAppEnvSchema` | `NEXT_PUBLIC_GITHUB_APP_SLUG` (install link only)                            |

**Supabase Edge Functions** — template in `supabase/functions/.env.example`, set in production with `supabase secrets set`

| Schema                     | Variables                                                                                     |
| -------------------------- | --------------------------------------------------------------------------------------------- |
| `edgeEnvSchema` (required) | `WEB_ORIGIN`                                                                                  |
| `edgeSupabaseEnvSchema`    | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (injected by the runtime)     |
| `inngestEnvSchema`         | `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`                                                    |
| `openAIEnvSchema`          | `OPENAI_API_KEY`                                                                              |
| `githubAppEnvSchema`       | `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_WEBHOOK_SECRET` |
| `edgeSentryEnvSchema`      | `SENTRY_DSN`, `SENTRY_ENVIRONMENT`                                                            |

Edge Functions read their variables with the `readEnv(name, schema)` helper in `supabase/functions/_shared/env.ts`.

---

## 14. Scalability Strategy

Optimize for simplicity first.

### Initial architecture

- Stateless Supabase Edge Functions
- Supabase PostgreSQL
- Server-side GitHub integration
- AI provider abstraction
- Inngest background jobs behind a job abstraction

### Scale when required

```text
Edge Functions + Inngest
   ↓
Tune Inngest concurrency / throttling
   ↓
Caching
   ↓
Dedicated repository indexing
```

Avoid introducing distributed infrastructure before workload requires it.

---

## 15. Architectural Principles

1. **Keep the frontend thin.**
2. **Keep business logic in the backend.**
3. **Keep AI behind an application-level abstraction.**
4. **Treat GitHub as an external system, not application storage.**
5. **Persist important interview state.**
6. **Make API operations stateless where possible.**
7. **Design for asynchronous processing without prematurely adding infrastructure.**
8. **Keep workspace, interview, and report boundaries explicit.**
9. **Optimize for a simple production deployment first.**
10. **Prefer replaceable infrastructure over infrastructure complexity.**

---

## 16. Core Architectural Boundary

The central domain relationship is:

```text
User
 └── Workspace
      ├── Repository
      ├── Interview
      │    ├── Questions
      │    ├── Answers
      │    └── Evaluations
      └── Reports
```

Everything outside this domain—GitHub, AI providers, hosting, and infrastructure—is treated as an external dependency.

This keeps StackPrep's core domain independent of individual infrastructure providers.
