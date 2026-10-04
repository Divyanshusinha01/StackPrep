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

Durable, event-driven jobs for repository indexing, analysis, and report generation. See [Background Processing](#12-background-processing).

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

**HTTP + Server-Sent Events (SSE)** for application APIs and server-to-client interview events. For voice interviews, the browser establishes a **WebRTC** connection directly with **OpenAI Realtime** for low-latency bidirectional audio and realtime model interaction.

| Concern                           | Transport                |
| --------------------------------- | ------------------------ |
| Create interview/session          | HTTP                     |
| Fetch interview state             | HTTP                     |
| Submit answers/events             | HTTP                     |
| Persist interview data            | HTTP                     |
| Server → client interview updates | SSE                      |
| Live voice conversation           | OpenAI Realtime + WebRTC |
| Audio streaming                   | WebRTC                   |
| Realtime model interaction        | WebRTC → OpenAI          |

```text
Browser
  │
  ├── HTTP ────────────────→ Backend
  │                           │
  │                           └── DB / business logic
  │
  ├── SSE ←──────────────── Backend
  │      interview state/events
  │
  └── WebRTC ───────────────→ OpenAI Realtime
           voice/audio
```

SSE is the application's realtime event transport. WebRTC is the AI voice transport. Do not use SSE for audio, and do not use WebRTC as the general-purpose application transport.

WebSockets are not required initially because application events are primarily server-to-client streaming.

#### Voice Session Flow

The browser never holds the OpenAI API key. The backend mints a short-lived ephemeral Realtime credential per voice session.

```text
1. Browser → Backend
   POST /interviews/:id/realtime/session

2. Backend → OpenAI
   Authenticates user, verifies interview ownership
   Uses server-side OPENAI_API_KEY
   Creates ephemeral Realtime credential (session config set server-side)

3. Backend → Browser
   Returns short-lived ephemeral credential

4. Browser → OpenAI Realtime
   WebRTC connection using ephemeral credential

5. Browser ↔ OpenAI
   Live audio + realtime events

6. Browser → Backend
   Transcript turns / interview events (HTTP)

7. Backend → DB
   Persist transcript + interview state
```

Rules:

- **Never expose `OPENAI_API_KEY` to the browser.** Only the short-lived ephemeral credential is returned to the client.
- The backend sets the Realtime session configuration (model, interviewer instructions, repository context, tools) when minting the credential. The client cannot override interviewer instructions or tool definitions. Tool calls are executed by the backend (see [Realtime Tool Execution & Persistence](#10-realtime-tool-execution--persistence)).
- The session endpoint authenticates the user, verifies interview ownership, and is rate-limited like other expensive AI endpoints.
- Ephemeral credentials are scoped to a single interview session and expire quickly. A new credential is requested for each connection or reconnection.

#### Transcript Ownership & Persistence

The StackPrep backend and database are the **canonical store** for interview transcripts. OpenAI Realtime handles the live conversation only; it is not application storage.

```text
OpenAI Realtime  = realtime voice / model execution
StackPrep backend = application state + persistent interview record
```

The backend persists:

- User / participant
- Interview ID
- Question / turn
- Transcript
- Timestamps
- Interviewer / model events
- Completion state
- Evaluation data

#### Reliability & Recovery

Do not rely on the browser uploading a single final transcript at the end of the interview.

- **Incremental capture.** The browser sends each completed transcript turn and important realtime event to the backend as it happens, not only at the end.
- **Idempotent writes.** Each transcript turn carries a client-generated `client_event_id` (UUID) and a turn `sequence`. A retry with the same `client_event_id` returns the original acknowledgement; a different `client_event_id` at an existing `sequence` is rejected as a conflict. Gaps in `sequence` are detectable.
- **Client buffering.** Events that fail to send are queued locally and retried until acknowledged.
- **Server-owned state.** Interview progress (current question, turns, plan coverage) lives in PostgreSQL, so the interview can resume from the last persisted turn.
- **Reconnection.** On disconnect, the browser requests a new ephemeral credential. The backend builds the new Realtime session from persisted interview state so the conversation continues where it stopped.
- **Completion is server-decided.** An interview is marked complete by the backend, which then triggers evaluation and report generation.

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
POST   /interviews/:id/realtime/session
POST   /interviews/:id/events
POST   /interviews/:id/tool-calls
GET    /interviews/:id/report
```

`POST /interviews/:id/realtime/session` returns a short-lived ephemeral Realtime credential. `POST /interviews/:id/events` accepts idempotent transcript turns and realtime interview events. `POST /interviews/:id/tool-calls` executes Realtime tool calls relayed by the browser (see [Realtime Tool Execution & Persistence](#10-realtime-tool-execution--persistence)).

The frontend should never directly call GitHub or the AI provider for privileged operations. The only direct browser-to-OpenAI connection is the WebRTC voice session, authorized by a backend-issued ephemeral credential.

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

### Voice Interview

```text
Browser
 → Interview API (POST /interviews/:id/realtime/session)
 → OpenAI (mint ephemeral credential with server-side key)
 → Browser
 → OpenAI Realtime (WebRTC, live audio)
 → Browser
 ├→ Interview API (POST /interviews/:id/events) → PostgreSQL
 └→ Interview API (POST /interviews/:id/tool-calls)
      → authenticate + Zod validate
      → PostgreSQL / Repository Context / AI Engine
      → structured result → Browser → OpenAI Realtime
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
- Voice transcript turns and realtime interviewer/model events
- Repository commit SHA

```text
Interview
├── repository_commit_sha
├── current_state
├── completion_state
└── message_history
     ├── question
     ├── answer
     ├── transcript turn (sequence, timestamps)
     ├── evaluation
     ├── interviewer/model events
     └── system events
```

Voice transcripts are part of the same append-only history as text answers. PostgreSQL is the canonical record; OpenAI Realtime session data is never treated as the source of truth.

The message history is append-only. Current state may be updated as the interview progresses.

This preserves the exact context used to generate the final report.

---

## 10. Realtime Tool Execution & Persistence

OpenAI Realtime runs the live conversation, but it never touches the database, GitHub, or privileged APIs. When the interviewer needs an application action (evaluate an answer, look at a file, advance the interview), it emits a **tool call**. Supabase Edge Functions are the only place tool calls are executed.

> Realtime decides **when** a tool is needed. Edge Functions decide **whether and how** it is executed.

### Principles

1. Realtime handles conversational interaction only.
2. Realtime tool calls represent application actions, not direct data access.
3. Edge Functions are the authoritative tool-execution boundary.
4. Supabase PostgreSQL remains the source of truth.
5. Repository/file retrieval goes through controlled tools pinned to the interview's commit SHA.
6. Transcript turns are persisted incrementally, independent of tool calls.
7. Tool inputs and outputs use shared Zod schemas in `@stackprep/shared`.
8. State-changing tools are requests; the backend decides whether they take effect.
9. The browser never receives privileged credentials (`OPENAI_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, GitHub tokens).

### Tool-call relay

With WebRTC, Realtime delivers tool calls to the **browser** over the session's data channel; OpenAI does not call the backend directly. The browser is a dumb relay: it forwards the call to the backend with the user's Supabase session and returns the backend's result to Realtime unchanged.

```text
OpenAI Realtime
  │  data channel: function call (call_id, name, arguments)
  ▼
Browser (relay only, no business logic)
  │  POST /interviews/:id/tool-calls  (Supabase user JWT)
  ▼
Supabase Edge Function
  ├── authenticate user, verify interview ownership and status = in progress
  ├── validate arguments with the tool's Zod schema
  ├── dedupe on call_id (idempotent)
  ├── execute: query PostgreSQL / Repository Context / AI engine
  ├── persist tool call + outcome to interview history
  └── return Zod-validated structured result
  │
  ▼
Browser
  │  data channel: function_call_output (call_id, result)
  ▼
OpenAI Realtime → continues the conversation
```

Rules:

- **Tools are declared server-side** in the Realtime session config when the ephemeral credential is minted. The client cannot add, remove, or redefine tools.
- **The backend never trusts the model's arguments.** Identifiers such as `interviewId` come from the authenticated route, not from tool arguments. Arguments are validated, size-limited, and scoped to the caller's interview.
- **Tool results returned to Realtime are guidance, not truth.** Because the browser relays results, a client could alter what Realtime hears. Authoritative outcomes (evaluations, coverage, completion) are computed and stored server-side; reports are generated from PostgreSQL, never from what the model said.
- **Unknown tools, invalid arguments, and authorization failures** return a structured error result so the interviewer can recover conversationally.
- A server-side sideband connection to the Realtime session is a possible future alternative to browser relay, but it requires a long-lived connection that does not fit the Edge Functions model and is not used initially.

### Tool catalogue

| Tool                | Purpose                                                                 | Mutates state                  |
| ------------------- | ----------------------------------------------------------------------- | ------------------------------ |
| `evaluate_answer`   | Evaluate the candidate's answer to the current question                 | Yes — server-decided           |
| `search_repository` | Find relevant files/excerpts in the indexed repository                  | No                             |
| `get_file`          | Retrieve a specific file or section at the interview's commit SHA       | No                             |
| `advance_interview` | Request the next question / coverage step from the interview engine     | Yes — server-decided           |
| `end_interview`     | Signal that sufficient evidence is gathered and the interview should close | Yes — server-decided        |

Transcript persistence is **not** a model tool. The model could skip or misreport it, so transcript turns are captured by the browser from Realtime transcription events and sent through `POST /interviews/:id/events` (see [Transcript persistence](#transcript-persistence)).

#### `evaluate_answer`

```text
Realtime
  → evaluate_answer({ questionMessageId, answerSummary })

Edge Function
  → authenticate, verify ownership
  → load question, interview state, plan coverage
  → load relevant Repository Context at the pinned commit SHA
  → AI engine evaluates the persisted transcript of the answer
  → persist evaluation (hidden from client)
  → return interviewer guidance (e.g. follow up on X, move on, clarify Y)

Realtime
  → asks follow-up / next question
```

The evaluation is based on the **persisted transcript**, not only on the model's `answerSummary`. Scores and internal reasoning stay server-side and are never returned to Realtime, so the interviewer cannot read them out (PRD: AI internal evaluation is never shown).

#### `search_repository` / `get_file`

Realtime never queries Supabase or GitHub directly.

```text
Realtime
  → search_repository({ query })
       ↓
Edge Function
       ↓
Ownership-checked query scoped to the workspace's indexed commit SHA
       ↓
Repository Context (file tree, important files, excerpts; later pgvector chunks)
       ↓
Secret-scrubbed, size-limited structured results
       ↓
Realtime
```

- Results only come from the indexed Repository Context for the interview's commit SHA (see [Repository Context](#6-repository-context)).
- Secret scrubbing and secret-bearing-file exclusion apply to tool output exactly as they do to AI ingestion.
- File content is returned as clearly delimited data. Repository content is untrusted and cannot override interviewer instructions.
- Examined files are recorded as `evidence_examined` interview events, which feed report scope evidence.
- This is the integration point for a future RAG/pgvector retrieval layer; the tool contract does not change.

### Server-decided mutations

Evaluations, coverage updates (via the `update_interview_state` database function, not a Realtime tool), and interview completion happen inside tool handlers, using the existing optimistic-concurrency version check.

`end_interview` is a request, not a command: the backend checks completion criteria (sufficient evidence or the ~30-minute target) before marking the interview `completed`. If accepted, it returns guidance for the interviewer to deliver a closing statement, then emits a `completion` event and triggers report generation. If rejected, it returns guidance to continue.

The candidate cannot voluntarily end or pause the interview (PRD §21). If a user-initiated early exit is added later, it must go through an explicit, authenticated UI confirmation — never spoken intent alone.

### Transcript persistence

Transcripts are persisted incrementally during the conversation, never only at the end. The Realtime session itself is ephemeral.

```text
Realtime transcription events (user + interviewer turns)
       ↓
Browser (buffer + retry until acknowledged)
       ↓
POST /interviews/:id/events   (idempotent: client event ID + sequence)
       ↓
interview_messages / interview_events (append-only)
       ↓
interview → workspace → user
```

This uses the existing tables rather than separate voice-session tables:

| Concept               | Stored in                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------- |
| Voice session         | The `interviews` row (one interview = one voice session; reconnects are events, not new sessions) |
| Transcript turns      | `interview_messages` (`role`, `content`, monotonic `sequence`, `metadata`)                   |
| Tool calls / outcomes | `interview_events` (`call_id`, tool name, validated args, result summary)                    |
| Connect / reconnect   | `interview_events`                                                                           |

Sequence ownership:

- `interview_messages.sequence` is assigned by the **browser** (transcript turns originate from Realtime transcription events on the client).
- `interview_events.sequence` is assigned by the **backend** for every event, including connect/reconnect events reported by the browser. The browser never supplies an event sequence.

`unique (interview_id, client_event_id)` makes transcript retries idempotent, and `unique (interview_id, sequence)` prevents two different turns from claiming the same position. Gaps in `sequence` are detectable.

Tool calls are idempotent per `call_id`: a partial unique index on `(interview_id, payload->>'call_id')` for `tool_call` events ensures a relayed retry is executed once.

Schema: `tool_call`, `connected`, and `disconnected` event types, `interview_messages.client_event_id`, and the `call_id` index are added in migrations `20261004140000_realtime_event_types.sql` and `20261004140100_realtime_idempotency.sql`.

---

## 11. Authentication & Authorization

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

## 12. Background Processing

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

## 13. Security

Key requirements:

- Encrypt sensitive GitHub credentials/tokens
- Keep secrets server-side
- Never expose `OPENAI_API_KEY` to the browser; voice sessions use backend-issued, short-lived ephemeral Realtime credentials
- Never expose `SUPABASE_SERVICE_ROLE_KEY` or GitHub tokens to the browser
- Execute Realtime tool calls only in Edge Functions; validate tool arguments with Zod and never trust model-supplied identifiers
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

## 14. Deployment

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

## 15. Scalability Strategy

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

## 16. Architectural Principles

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

## 17. Core Architectural Boundary

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

OpenAI Realtime executes the live voice conversation; the StackPrep backend owns application state and the persistent interview record.

This keeps StackPrep's core domain independent of individual infrastructure providers.
