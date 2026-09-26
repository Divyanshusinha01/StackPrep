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

The system is split into a Next.js frontend, Hono API, PostgreSQL database, GitHub integration, and AI interview engine.

---

## 2. Architecture

```text
                    ┌─────────────────┐
                    │     Next.js     │
                    │    Frontend     │
                    └────────┬────────┘
                             │ HTTPS
                             ▼
                    ┌─────────────────┐
                    │   Hono / Node   │
                    │      API        │
                    └──────┬────┬─────┘
                           │    │
              ┌────────────┘    └─────────────┐
              ▼                               ▼
       ┌─────────────┐                 ┌─────────────┐
       │ PostgreSQL  │                 │   GitHub    │
       │             │                 │     API     │
       └─────────────┘                 └─────────────┘
                           │
                           ▼
                    ┌─────────────────┐
                    │   AI Engine     │
                    │ Interview +     │
                    │ Evaluation      │
                    └─────────────────┘
```

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

### Backend — Hono + Node.js

Responsibilities:

- Authentication and authorization
- GitHub integration
- Repository metadata
- Workspace management
- Interview orchestration
- AI requests
- Report generation
- Persistence

The backend is the primary application boundary.

### Database — PostgreSQL

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

### GitHub

Used to:

- Authenticate/connect users
- List accessible repositories
- Read repository metadata
- Read relevant source files during analysis

GitHub credentials/tokens are never exposed to the browser.

### AI Engine

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
 → Hono
 → GitHub API
 → PostgreSQL
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

### Initial implementation

Use a PostgreSQL-backed jobs table with a lightweight worker.

```text
API
 ↓
jobs table
 ↓
Worker
 ↓
Job handler
 ↓
PostgreSQL / external service
```

Jobs should have:

- `id`
- `type`
- `status`
- `payload`
- `attempts`
- `available_at`
- `locked_at`
- `completed_at`
- `error`

Workers claim jobs transactionally using PostgreSQL row-level locking:

```sql
SELECT *
FROM jobs
WHERE status = 'pending'
  AND available_at <= NOW()
ORDER BY available_at
FOR UPDATE SKIP LOCKED
LIMIT 1;
```

The selected job is marked as locked/processing within the same transaction. This allows multiple workers to process jobs concurrently without claiming the same job.

The application should expose a job abstraction so the implementation can later move to Redis/BullMQ without changing domain code.

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
                    Internet
                       │
             ┌─────────┴─────────┐
             ▼                   ▼
          Vercel              Render
        Next.js             Hono/Node
                                │
                    ┌───────────┼───────────┐
                    ▼           ▼           ▼
               PostgreSQL    GitHub       AI API
```

Frontend and backend are independently deployable.

Environment-specific configuration is managed through environment variables.

---

## 14. Scalability Strategy

Optimize for simplicity first.

### Initial architecture

- Stateless API
- PostgreSQL
- Server-side GitHub integration
- AI provider abstraction
- Simple background-job abstraction

### Scale when required

```text
Single API
   ↓
Multiple API instances
   ↓
Job Queue + Workers
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
