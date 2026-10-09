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
              │               │ OpenAI                │
              │               └───────────┬───────────┘
              └───────────────────────────┘
```

Request/response work runs in Supabase Edge Functions. Long-running work (indexing, analysis, interview planning, report generation) runs as Inngest functions, which call GitHub and OpenAI and persist results back to Supabase.

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
- AI usage (per-call tokens and estimated cost)

Repository source code itself should not be treated as primary database data.

### Auth & Storage — Supabase Auth, Supabase Storage

Supabase Auth handles user authentication. Supabase Storage holds file artifacts (e.g. generated reports, uploaded media).

### Background Jobs — Inngest

Durable, event-driven jobs for repository indexing, deep analysis, repository memory embedding, interview planning, and report generation. See [Background Processing](#12-background-processing).

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

#### Models

Each task reads its model from an environment variable, so models can change without code changes.

| Task                                   | Model                        | Variable                 |
| -------------------------------------- | ---------------------------- | ------------------------ |
| Live voice interviewer                 | `gpt-realtime-2.1-mini`      | `OPENAI_REALTIME_MODEL`  |
| Live candidate speech transcription    | `gpt-4o-mini-transcribe`     | `OPENAI_REALTIME_TRANSCRIPTION_MODEL` |
| Interview planning                     | `gpt-6.1-sol`                | `OPENAI_PLANNING_MODEL`  |
| Deep analysis                          | `gpt-6.1-sol`                | `OPENAI_PLANNING_MODEL`  |
| Answer evaluation, report generation   | `gpt-6-luna`                 | `OPENAI_EVALUATION_MODEL` |
| Integrity monitoring                   | `gpt-6-luna`                 | `OPENAI_VISION_MODEL`    |
| Repository memory and search query embeddings | `text-embedding-3-small` | `OPENAI_EMBEDDING_MODEL` |

Planning and evaluation keep separate variables, so either can change on its own. Evaluation and vision use the same model today but also keep separate variables.

The transcription model is set on the Realtime session when the backend mints the credential. It transcribes only the candidate's speech for the persisted transcript; the interviewer's own transcript comes from the voice model.

The transcription model must be supported as input transcription inside a WebRTC Realtime voice session with `server_vad`. `gpt-4o-mini-transcribe` is, but OpenAI removes it on **Feb 26, 2027**. Its recommended replacements do not fit this session: `gpt-live-transcribe` runs only in a dedicated transcription session (`type: "transcription"`) with `turn_detection: null`, and `gpt-transcribe` runs inside a Realtime session only over WebSocket. Migrating therefore needs a second, transcription-only WebRTC session on the same microphone track, committed on the voice session's `speech_stopped`, with its item ids mapped back to the voice session's turns. That design is not yet adopted.

Deep analysis is a single structured call per analyzed commit and reuses `OPENAI_PLANNING_MODEL` rather than adding its own variable. Its token usage is persisted to `ai_usage` with task `deep_analysis` and no interview, like every other AI call (see [Usage tracking](#usage-tracking)).

The embedding model must natively produce 1536-dimensional vectors, the size of `repository_memory.embedding` (`vector(1536)`, `REPOSITORY_MEMORY_EMBEDDING_DIMENSIONS`). `OPENAI_EMBEDDING_MODEL` may only change to a model that outputs 1536 dimensions natively. The request never sends `dimensions`, so output is never truncated implicitly (for example, `text-embedding-3-large` with `dimensions: 1536` is not supported); that would be a separate decision with its own configuration and a re-embed. Every returned vector is checked for exactly 1536 finite values: a mismatch fails the background run with the non-retriable `embedding_dimension_mismatch` without writing anything, and search falls back to keyword results. Embeddings from different models are not comparable; changing the model re-embeds a commit's rows the next time its embedding run executes.

#### Cost controls

The live voice session is the main AI cost, so most controls target it.

- **Session length.** Voice time is the sum of connected time, measured from `connected` / `disconnected` interview events. At 30 minutes the backend tells the interviewer to wrap up. At 35 minutes the backend completes the interview, refuses new Realtime credentials, and tool calls return an instruction to close. See [Voice Session Flow](#voice-session-flow) for how this is enforced.
- **Idle timeout.** The browser closes the voice session after 3 minutes without candidate speech and records a `disconnected` event. The user can reconnect within the remaining voice time.
- **Usage limit.** `POST /workspaces/:id/interviews` rejects a request when the user has created 5 or more interviews in the previous 24 hours, returning `429 interview_limit_reached` with `Retry-After`. Every created interview counts.
- **Cached prompt prefix.** Realtime session instructions are assembled in a fixed order: interviewer instructions, then repository context, then the interview plan, then changing state (progress, current question, recap). The first three are byte-identical across sessions of the same interview, so reconnects get cached-input pricing.
- **Context trimming.** Sessions enable OpenAI's automatic truncation of older turns. On reconnect, the backend replaces the full transcript with a compact recap of covered topics and the current question. The full transcript stays in PostgreSQL for evaluation and the report.
- **Bounded inputs.** Repository context and tool results are already size-limited (see [Repository Context](#6-repository-context) and the [Tool catalogue](#tool-catalogue)).
- **Vision.** The browser sends one low-detail camera frame every 10 seconds to the backend, which forwards it to the vision model. Only the resulting signal is stored; frames are never persisted.

#### Usage tracking

Every AI call writes a row to `ai_usage` (migration `20261006100000_ai_usage.sql`): user, workspace, interview (null for repository analysis), task (`voice`, `auxiliary`, `deep_analysis`, `planning`, `evaluation`, `report`, `vision`, `embedding`), model, `source`, input / cached-input / output tokens split into text and audio, `audio_seconds` for duration estimates, the voice segment for voice rows, estimated cost in USD, an idempotency key, and a timestamp. `auxiliary` is a reserved task with no callers; it stays in the enum because Postgres enum values cannot be dropped cleanly. The table is service-role only and append-only: updates are rejected, and the service role can only select and insert. `embedding` (migration `20261007100000_ai_usage_embedding_task.sql`) covers both repository memory embeddings (no interview) and `search_repository` query embeddings (with the interview); embeddings bill input tokens only.

Cost is computed by `estimateCostUsd` from the price table in `@stackprep/shared` (`AI_PRICES`, USD per 1M tokens). Following OpenAI's `usage`, input counts include their cached portion, so each modality is billed as `(input − cached) × input rate + cached × cached rate + output × output rate`; a model without a cached rate bills cached tokens at the input rate. A model missing from the table gets a null cost, and the row is still written. Raw token counts are kept, so rows can be recalculated if prices change.

`source` says how much a row can be trusted:

| Source              | Meaning                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------- |
| `provider`          | Counts the provider returned to the backend. Authoritative.                                 |
| `client_reported`   | Counts relayed by the browser. Provisional; used for voice cost until provider usage exists. |
| `duration_estimate` | Derived from connected voice time. An approximation, never presented as actual spend.        |

Text and vision calls (planning, deep analysis, report, answer evaluation, integrity frames) are recorded by the backend from OpenAI's response `usage` as `provider` rows, through `recordAiUsage` in `supabase/functions/_shared/ai-usage.ts`. A failed insert is logged and never fails the user-facing flow. Inngest jobs key each row per model call, so a retried step that calls the model again is recorded as the second spend it is. Vision rows are keyed by the integrity check.

Voice usage belongs to a **voice segment**: the connected time opened by a `connected` interview event and closed by the next `disconnected` or `connected`, using the same pairing as voice time.

- **Relayed usage.** The browser relays each Realtime `response.done` usage through `POST /interviews/:id/events` as a `voice_usage` event (`client_event_id`, `response_id`, text and audio input / cached-input / output tokens). The backend stores it as a `client_reported` row for the server's `OPENAI_REALTIME_MODEL`, linked to the open segment, idempotent on `client_event_id`, with each count capped and cached counts never above input. Usage relayed while no segment is open is rejected with `409 voice_not_connected`.
- **Duration estimate.** When a segment closes (a `disconnected`, a `connected` that implies a missed disconnect, or the 35-minute limit completing the interview), the backend writes two `duration_estimate` rows keyed by the segment, so each segment is estimated once: the realtime model, priced from `ESTIMATED_REALTIME_AUDIO_TOKENS_PER_SECOND`, and the transcription model, priced per minute (`TRANSCRIPTION_ESTIMATED_USD_PER_MINUTE`, $0.003/min for `gpt-4o-mini-transcribe`) with no token counts.

The view `ai_usage_effective` applies the reconciliation rule without changing raw rows. Non-voice rows pass through. For voice, per segment and model, it uses `provider` rows if any exist, else `client_reported` rows, else the `duration_estimate` row, flagged `is_estimate`. So relayed usage supersedes the realtime estimate, while the transcription estimate stands until provider-side transcription usage exists. The superseded estimate stays in `ai_usage` as the cross-check for client-reported numbers.

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

Planning runs as an Inngest job, overlapped with the camera and microphone check:

```text
1. Browser → Backend
   POST /workspaces/:id/interviews

2. Backend
   Authenticates user, verifies workspace ownership and status = ready
   Creates interviews row (status = created, pinned commit SHA)
   Creates empty interview_state row
   Sends interview.planning.requested event
   Returns the interview immediately

3. Browser
   Runs the camera + microphone check while planning runs

4. Inngest (interview planning)
   Loads repository memory for the pinned commit SHA
   Loads previous interview outcomes for the workspace (coverage, strengths, weaknesses)
   OpenAI builds coverage map, high-level plan, and strategy
   Writes them via update_interview_state

5. Browser → Backend
   POST /interviews/:id/realtime/session
   Returns interview_preparing until the plan exists
```

- The planner uses whatever repository memory exists. If deep analysis has not finished, it plans from the baseline analysis.
- Previous interview outcomes guide question selection only; previous answers are never evidence of current ability.
- If planning fails after retries, the job records a fixed error code and the UI offers a retry. The interview stays `created`.

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

**Where SSE and polling are used:**

| Surface | Transport |
| --- | --- |
| Interview events (`interview_status`, `turn_persisted`, `report_ready`) | SSE, `GET /interviews/:id/events` |
| Repository analysis progress, interview lobby readiness, pending reports | Polling: the page re-renders every 4 s (`use-poll-while.ts`) from persisted job state |

**Interview event stream.** Events are derived from rows that already exist; there are no stream-only tables or event types:

- `interview_status`: `interview_events` rows of type `start`, `completion`, `termination`, mapped to `in_progress`, `completed`, `terminated`. Data: `{ status, event_sequence, occurred_at }`.
- `turn_persisted`: `interview_messages` rows (interviewer and candidate). Data: `{ turn_sequence, role, client_event_id, item_id? }`, the same identity fields as the `POST /interviews/:id/events` ack, so the browser's outbox can drop an unacked copy instead of resending it. No transcript content is sent.
- `report_ready`: the `reports` row exists. Data: `{ generated_at }`. Terminal: sent once, after which the server closes the stream.

Other interview events (pause, resume, connected, integrity, tool calls, evidence) are not streamed. Contracts live in `packages/shared/src/realtime.ts`.

- **Composite cursor.** The two tables have separate sequences, so each frame's SSE `id:` is the cursor after it: `<event_sequence>.<turn_sequence>.<report_flag>` (e.g. `12.40.0`). A reconnect replays only events strictly after every component, so nothing is delivered twice, and a cursor with `report_flag = 1` never receives `report_ready` again. No cursor replays from `0.0.0`; a malformed cursor returns `400 invalid_cursor` instead of replaying; a cursor ahead of the data emits nothing until new rows pass it. The cursor is read from `Last-Event-ID`, or `?last_event_id=` for readers that cannot set headers; the header wins.
- **Server.** Authenticated with the caller's RLS client and an ownership check like other reads (`401`, `404 interview_not_found`). Responses are `text/event-stream`, `Cache-Control: no-store`. The first frame is a `retry:` hint; frames are `id:` + `event:` + single-line JSON `data:`; an idle stream gets a `: heartbeat` comment every 15 s (no `id:`, so the cursor does not move). The function reads the three sources about every 1.5 s (no Supabase Realtime dependency), merges new rows by `created_at`, and closes cleanly after `report_ready`, after 140 s (under the 150 s Edge Function wall-clock limit on the free plan), on a read failure, or when the client disconnects.
- **Browser.** Native `EventSource` cannot send the `Authorization` header, so the interview room uses a fetch-based reader (`interview-event-stream.ts`, `use-interview-events.ts`) that keeps the last received id and sends it on every reconnect. Statuses end or terminate the room (a streamed completion waits up to 30 s for a live closing turn), `turn_persisted` confirms outbox entries, and `report_ready` moves an ended room to the report. After 3 consecutive failed connects the reader stops and the page falls back to 4 s polling for the rest of the session.
- **Cost.** Each open stream reads the database about every 1.5 s. This is acceptable at current scale; revisit with Supabase Realtime if needed.

WebSockets are not required initially because application events are primarily server-to-client streaming.

#### Voice Session Flow

The browser never holds the OpenAI API key. The backend mints a short-lived ephemeral Realtime credential per voice session.

```text
1. Browser → Backend
   POST /interviews/:id/realtime/session

2. Backend → OpenAI
   Authenticates user, verifies interview ownership
   Verifies the interview plan exists (otherwise returns interview_preparing)
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
- The session endpoint refuses a credential once the interview has used its 35 minutes of voice time, and returns the remaining voice time with each credential so the browser can show the wrap-up and close the session on time.
- After the 35-minute cap, `POST /interviews/:id/tool-calls` returns an end-interview instruction and the backend marks the interview complete. Without a server-side sideband connection, the backend cannot force-close a live WebRTC session. A client that ignores the instruction is bounded by OpenAI's maximum Realtime session length and cannot reconnect.

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
- **Idempotent writes.** Each transcript turn carries a client-generated `client_event_id` (UUID); the backend assigns the turn `sequence`. A retry with the same `client_event_id` returns the original acknowledgement, including its sequence; reusing a `client_event_id` for a different payload is rejected as a conflict. Because the client holds no sequence state, clearing browser storage or continuing on another device cannot collide with stored turns.
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

Analysis runs in two stages, matching the PRD's lightweight-then-deeper flow.

**Baseline analysis** (`repository_indexing` job) is rule-based: file-tree analysis, metadata/dependency analysis, and lightweight fact extraction per file, with secret scrubbing. The workspace becomes `ready` when it completes.

**Deep analysis** (`deep_analysis` job, Inngest event `repository.deep_analysis.requested`) starts after the baseline. It sends the scrubbed baseline memory for the analyzed commit to OpenAI using `OPENAI_PLANNING_MODEL` in one structured call and adds AI-derived repository memory:

- Architecture summary
- Major modules
- Major technical decisions
- Security-sensitive areas
- Repository-specific concepts

How it runs:

- **Trigger.** After the baseline marks the job succeeded and the workspace ready, the baseline function runs a separate, best-effort step that calls `request_deep_analysis` and enqueues the event. It only runs when the analyzed commit is still the workspace target. A failure there is logged (`deep_analysis_enqueue_failed`) and recorded on the deep job as `enqueue_failed`; it never changes the baseline result or the workspace status.
- **One job per commit.** `request_deep_analysis` returns no job when the commit has no baseline `architecture_summary` row, when that row already carries `metadata.deep_analysis`, or when a deep analysis is already active for the workspace (partial unique index `jobs_active_deep_analysis_key`). Only the given commit is checked, so an analyzed older commit never suppresses a new one.
- **Validation.** The output is re-validated against `deepAnalysisOutputSchema`, evidence paths that are not baseline `key_files` paths of the commit are dropped (modules and security areas left without evidence are dropped too), concepts are de-duplicated by normalized term, and caps are enforced. Output that is empty after this fails with `ai_invalid_output` and nothing is stored.
- **Storage.** `save_deep_analysis` writes, in one transaction: `structured.ai` on the commit's `architecture_summary` (summary, technical decisions, security-sensitive areas) and `modules` rows, one `concepts` row for the commit, and the `metadata.deep_analysis` marker (`model`, `analyzer_version`, `generated_at`). `structured.ai` is replaced rather than merged, so retries are idempotent. Failures are recorded only on the job (`fail_deep_analysis`), never on the workspace.

| Memory row             | Deep analysis output                                        |
| ---------------------- | ----------------------------------------------------------- |
| `architecture_summary` | `structured.ai`: summary, technical decisions, security-sensitive areas; `metadata.deep_analysis` marker |
| `modules`              | `structured.ai`: important modules with evidence files      |
| `concepts`             | New row: `content` (term: explanation lines) and `structured.ai.concepts` |

Deep analysis does not block interviews. Planning includes the `structured.ai` sections inside its fenced repository memory, within a fixed budget, and uses the baseline alone when deep analysis has not finished. Repository memory persists across interviews, so this understanding is computed once per commit SHA rather than per interview; re-analysis of a new commit runs deep analysis again for that commit.

**Memory embeddings** (Inngest event `repository.memory_embedding.requested`, function `memory-embedding`) give each repository memory row of a commit a `pgvector` embedding for semantic retrieval in `search_repository`:

- **Trigger.** A best-effort step (`queue-memory-embedding`) after the baseline completes with the workspace ready, both after a fresh analysis and when existing memory is reused (which backfills already analyzed commits), another after deep analysis writes its result, since that creates or rewrites the `concepts` row, and another after the code index saves its `code_module` and `file_summary` rows. A failed enqueue is logged (`memory_embedding_enqueue_failed`) and never changes the triggering job's result. The event carries `workspace_id`, the originating `job_id` (baseline or deep analysis job), and `commit_sha`. There is no `jobs` row: embeddings are invisible to users, and failures are visible only in logs and Sentry.
- **Input.** Every row of the commit with non-empty content, embedded as `kind` + newline + `content` (scrubbed again, capped at 8,000 characters). `structured` (including `structured.ai`) is not embedded, so deep analysis adding `structured.ai` to baseline rows does not re-embed them.
- **Change detection.** `metadata.embedding` stores `model`, `dimensions`, `input_hash`, `input_version`, and `embedded_at`. `input_hash` is a SHA-256 of the model, input version, kind, and content. A row is embedded when its embedding is null or its hash differs, so unchanged content is never re-embedded and a model or input-version change re-embeds deliberately.
- **Writes.** Rows are embedded in batches of at most 64 and written one by one with a compare-and-set on `updated_at`, so a concurrent `save_deep_analysis` marker is never clobbered. On a miss the row is reloaded once: if its content is unchanged the write is retried with the fresh metadata and the vector already computed; otherwise the row is skipped as superseded and the run triggered by that change covers it. A retried batch drops rows that are already current. Rows of other commits are never touched.
- **Failures.** Rate limits are retried after the provider's delay, unavailability and malformed output are retried, and rejected requests and dimension mismatches are non-retriable. Memory, jobs, and workspace status are never changed; rows without an embedding are skipped by `match_repository_memory`, and search keeps working with keyword results.

Embeddings are per memory row, not per AST node or chunk: about seven baseline rows per commit, plus the code index's `code_module` and symbol-outline `file_summary` rows (below). Vector hits answer conceptual questions at summary, directory and file-outline level, while path- and symbol-precise lookups stay keyword-driven. Raw source is never embedded.

**Code index** (`code_indexing` job, Inngest event `repository.code_index.requested`, function `code-index`) parses source files with Tree-sitter and stores commit-pinned syntactic facts:

- **Parser.** `packages/code-parser` is a project-agnostic package (no StackPrep, Supabase, GitHub or Inngest imports) built on `web-tree-sitter` with vendored, version-pinned WASM grammars for TypeScript/TSX, JavaScript/JSX, Python, Java and Go. A language registry maps extensions to a grammar and declarative Tree-sitter queries; adding a language is a registry entry, not an engine change (C/C++ are deferred). `parseFile` returns `CodeFacts` (symbols with parent links and 1-based ranges, imports, exports, call sites, error ranges, `status: ok | partial | failed | unsupported`) and never throws for bad input. Facts are syntactic only: no type inference, no name resolution, no cross-file call graph. `PARSER_VERSION` is stored with every file so a logic change forces a re-parse.
- **Runtime.** It runs inside the `inngest` Edge Function; the grammars ship as `static_files`. A hard-gate spike on hosted Supabase Edge (bundle size, cold starts, CPU and memory per batch, malformed input) set the limits: at most 400 files and 4 MB per commit, 64 KB per file, and at most 25 files / 600 KB per durable step.
- **Trigger.** A best-effort `queue-code-index` step after the baseline completes with the workspace ready (also when memory is reused), next to the deep analysis step. `request_code_index` returns no job when the commit has no baseline, is already indexed with the current parser version, or a code index is already active (`jobs_active_code_indexing_key`). It never affects workspace readiness; interviews start without it and tools behave as before until it exists.
- **Selection.** Blobs that pass the baseline `classifyPath` filter and have a registered language, ordered by baseline relevance then path. Oversized files are recorded as skipped without being fetched. Limits hit are recorded.
- **Per-file isolation.** Each batch is its own `step.run`. Undecodable (non-UTF-8 or NUL), secret-bearing (the same `scrubSecrets` check as `get_file`), unfetchable, unsupported or failed files become `code_files` rows with a `parse_status` and `skipped_reason`; the run still succeeds. Only systemic failures (GitHub rate limits, outages, lost access, database errors) retry, mapped to the baseline's fixed error codes.
- **Storage.** Migrations `20261008100000_code_indexing_job_type.sql`, `20261008100100_code_index.sql` and `20261008100200_code_memory.sql` add `code_files`, `code_symbols`, `code_imports` and `code_calls`, owned like `repository_memory` (composite FK to `workspaces`, owner-select RLS, writes only through service-role functions). Source text is never stored: only names, kinds, ranges, specifiers, callee text and a short signature. `replace_code_index` writes one batch; a file whose facts hash and parser version are unchanged is left as is, any other file at the same commit and path is replaced with its facts, so stale facts never survive and other commits are never touched. `complete_code_index` records counts, languages and limits in the commit's metadata-only `code_index` memory row (empty content, never embedded); `prune_code_index` then drops other commits except the workspace target and commits pinned by active interviews.
- **Memory rows.** `save_code_memory` replaces the commit's code-index rows (`metadata.source = 'code_index'`): one `code_module` row per directory (indexed files, top exported symbols, directories it imports from, external imports) and a symbol-outline `file_summary` row for each of the 40 most relevant files with declarations. Unchanged rows keep their embedding. They enter the existing memory embedding pipeline after the run. Readers that load commit summaries (planning, deep analysis, report, realtime instructions, evaluation) skip `code_index` and `code_module` rows.
- **Reads.** Security-invoker functions `find_symbol`, `find_importers`, `find_dependencies`, `find_callers` and `search_code_symbols`, all scoped to a workspace and commit. `resolved_path` on imports is a path-only guess for relative specifiers. Results are labeled syntactic (name-based, unresolved) and must not be presented as precise semantics.

```text
Repository
    ↓
Commit SHA
    ↓
Baseline analysis  →  workspace ready
    ↓
Deep analysis + memory embeddings (background)
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
GET    /interviews/:id/events          (SSE)
POST   /interviews/:id/tool-calls
POST   /interviews/:id/integrity/frames
POST   /interviews/:id/pause
POST   /interviews/:id/resume
POST   /interviews/:id/end
DELETE /interviews/:id
GET    /interviews/:id/report
```

`GET /interviews/:id/events` is the server-to-client event stream (see [Transport](#transport)).

`POST /interviews/:id/pause` is the candidate's **Stop interview** (PRD §21), sent only after a UI confirmation. The service-role function `pause_interview` (migration `20261008120000_voluntary_pause.sql`) moves an `in_progress` interview to `paused`, sets `paused_at`, increments `pause_count` (at most 3, otherwise `409 pause_limit_reached`), writes a `pause` event with `{ "reason": "user" }`, and, if a voice segment is open, closes it with a server-side `disconnected` so voice time stops even if the browser never reports its own. It returns `{ status: "paused", pauses_left, resume_by }`; repeating it while paused returns the same deadline. While paused, `POST /realtime/session` returns `409 interview_paused`, and tool calls and integrity frames are refused because they require `in_progress`.

`POST /interviews/:id/resume` (function `resume_interview`) moves a paused interview back to `in_progress` and writes a `resume` event, after which the browser opens a new voice session that resumes from the persisted state like any reconnect. If more than 1 hour has passed since `paused_at`, it instead terminates the interview with `termination_reason = 'user_abandoned'` and a `termination` event, and returns `409 pause_expired`. Expiry is checked lazily on resume. Until then, an expired pause stays `paused` in the database, and the history UI shows it as expired.

`POST /interviews/:id/end` is the candidate's **End interview** (PRD §21), sent only after a UI confirmation, from the live room or the paused screen. Before calling it, the browser closes the voice session and flushes its transcript outbox, so buffered turns are stored before the report job reads them (`/events` also accepts turns after the interview ends). The service-role function `end_interview_by_user` (migrations `20261008140000_user_ended_reason.sql` and `20261008140100_user_end_interview.sql`) takes the per-interview advisory lock and accepts `in_progress` or `paused` interviews. It closes any open voice segment with a server-side `disconnected` (`{ "source": "user_end" }`), then:

- with at least one row in `evaluations`, sets `completed` with `termination_reason = 'user_ended'`, clears `paused_at`, and writes a `completion` event `{ "reason": "user_ended" }`. The handler records voice duration estimates for the closed segment and queues report generation through the same `requestReport` path as the voice cap. It returns `201 { status: "completed", report: true }`.
- with no evaluation, sets `terminated` with `termination_reason = 'user_abandoned'` and writes a `termination` event `{ "reason": "user_abandoned", "source": "user_end" }`. No report is queued. It returns `201 { status: "terminated", report: false }`.

Repeating the call on a completed interview, or one already terminated as `user_abandoned`, writes nothing and answers `200` with the same shape. Any other state (not started, or ended some other way) returns `409 interview_not_active`. Tool calls, integrity frames, and voice sessions need no extra guard, because they all require `in_progress`.

`DELETE /interviews/:id` removes an ended interview from the candidate's history (PRD §28), sent only after a UI confirmation. It is a soft delete: the row is kept and `interviews.deleted_at` is set, because the 5-per-24h usage limit, `interview_number` assignment (`max + 1`), `ai_usage`, and planning memory all read interview rows, and a hard delete would cascade to messages, events, reports, and usage. The service-role function `delete_interview` (migration `20261008160000_delete_interview.sql`) takes the per-interview advisory lock and sets `deleted_at` only when the status is `completed`, `terminated`, or `failed`. It returns `200 { status: "deleted" }`, also when a concurrent request deleted it first. A pending, in-progress, or paused interview returns `409 interview_not_ended`.

The same migration changes the owner RLS policies so a deleted interview is hidden from its owner: `interviews` requires `deleted_at is null`, and `interview_messages`, `interview_events`, `reports`, and interview-linked `jobs` require a non-deleted parent interview (workspace jobs with no `interview_id` stay visible). Because of this, history, report, and transcript reads in the web app need no extra filter, and endpoints that load the interview through the user's RLS client, including a later repeated `DELETE`, answer `404 interview_not_found` for a deleted one. Service-role readers bypass RLS and ignore `deleted_at`, so a deleted interview still counts toward the usage limit, keeps its number, and remains previous-interview context for planning and reports.

`POST /interviews/:id/integrity/frames` accepts one low-detail camera frame (about every 10 seconds), sends it to the vision model, stores only the detected signal, and returns any warning to show. Frames are never persisted.

`POST /workspaces/:id/interviews` creates the interview and enqueues planning (see [Phase 1 — Planning](#phase-1--planning)). `POST /interviews/:id/realtime/session` returns a short-lived ephemeral Realtime credential, or `interview_preparing` while the plan is still being generated. `POST /interviews/:id/events` accepts idempotent transcript turns and realtime interview events. `POST /interviews/:id/tool-calls` executes Realtime tool calls relayed by the browser (see [Realtime Tool Execution & Persistence](#10-realtime-tool-execution--persistence)).

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
 → Inngest (baseline analysis → workspace ready → deep analysis)
 → Workspace
```

### Interview Planning

```text
Workspace
 → Interview API (POST /workspaces/:id/interviews)
 → PostgreSQL (interview created)
 → Inngest (interview planning)
 → Repository memory + previous interview outcomes
 → AI Engine
 → PostgreSQL (interview_state)
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

#### Tool schemas

Shared Zod contracts in `@stackprep/shared`. All limits are enforced server-side. No tool accepts an interview ID or other database identifier; the interview comes from the authenticated route.

```ts
// Common error result, so the interviewer can recover conversationally
toolErrorSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: z.enum(["invalid_arguments", "unknown_tool", "interview_not_active",
                  "not_found", "excluded", "rate_limited", "internal"]),
  }),
});

// search_repository (read-only)
searchRepositoryInput = z.object({
  query: z.string().trim().min(1).max(200),
  limit: z.int().min(1).max(8).default(5),
});
searchRepositoryOutput = z.object({
  ok: z.literal(true),
  results: z.array(z.object({
    path: z.string(),
    area: z.string().optional(),        // module / repository area
    excerpt: z.string().max(1500),      // secret-scrubbed, delimited as data
    symbol: z.string().optional(),      // code index hit: `name` or `Parent.name`
    kind: z.string().optional(),        // function, method, class, ...
    startLine: z.int().optional(),      // declaration range at the pinned commit
    endLine: z.int().optional(),
  })),
});

// get_file (read-only, pinned to the interview's commit SHA)
getFileInput = z.object({
  path: z.string().min(1).max(512),
  startLine: z.int().min(1).optional(),
  endLine: z.int().min(1).optional(),   // window capped server-side (~200 lines)
  symbol: z.string().min(1).max(256).optional(), // read one declaration; not combined with lines
});
getFileOutput = z.object({
  ok: z.literal(true),
  path: z.string(),
  startLine: z.int(),
  endLine: z.int(),
  totalLines: z.int(),
  content: z.string(),
  truncated: z.boolean(),
  symbol: fileSymbol.optional(),        // what a `symbol` request resolved to
  symbols: z.array(fileSymbol).max(50).optional(), // declarations overlapping the window
});
// fileSymbol = { name, kind, parent?, startLine, endLine }

// evaluate_answer (server resolves the current question)
evaluateAnswerInput = z.object({
  answerSummary: z.string().trim().min(1).max(1000),
});
evaluateAnswerOutput = z.object({
  ok: z.literal(true),
  guidance: z.enum(["follow_up", "clarify", "move_on"]),
  focus: z.string().max(300).optional(), // e.g. "probe refresh token rotation"; never a score
});

// advance_interview (server picks the next coverage step)
advanceInterviewInput = z.object({});
advanceInterviewOutput = z.object({
  ok: z.literal(true),
  nextFocus: z.object({
    area: z.string(),                   // e.g. "src/auth"
    category: z.string(),               // e.g. "security"
    angle: z.string().max(300),
  }),
  depth: z.enum(["foundational", "standard", "deep"]),
  elapsedMinutes: z.int(),
});

// end_interview (request; the server may reject it)
endInterviewInput = z.object({
  reason: z.enum(["sufficient_evidence", "time_target"]),
});
endInterviewOutput = z.object({
  ok: z.literal(true),
  accepted: z.boolean(),
  guidance: z.string().max(300),        // closing-statement cue or "continue with…"
});
```

- Outputs never contain scores, internal reasoning, or coverage progress.
- `get_file` returns `excluded` for generated, binary, oversized, or secret-bearing files.
- `search_repository` ranks Repository Context by keyword first, adds code index symbol hits, and when that finds fewer than `limit` hits, embedded memory rows fill the rest (see [`search_repository` / `get_file`](#search_repository--get_file)). The symbol fields are optional, so existing results stay valid.
- `get_file` with `symbol` returns `not_found` when the file is not in the code index or has no such declaration, and `invalid_arguments` when combined with `startLine`/`endLine`.

#### `evaluate_answer`

```text
Realtime
  → evaluate_answer({ answerSummary })

Edge Function
  → authenticate, verify ownership
  → resolve the current question from interview_messages
  → load interview state, plan coverage
  → load relevant Repository Context at the pinned commit SHA
  → AI engine evaluates the persisted transcript of the answer
  → persist evaluation (hidden from client)
  → return interviewer guidance (e.g. follow up on X, move on, clarify Y)

Realtime
  → asks follow-up / next question
```

The model never supplies the question identifier; the backend resolves the current question itself. The evaluation is based on the **persisted transcript**, not only on the model's `answerSummary`. Scores and internal reasoning stay server-side and are never returned to Realtime, so the interviewer cannot read them out (PRD: AI internal evaluation is never shown).

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
Keyword search over Repository Context (file tree, important files, excerpts)
  + symbol search over the code index (search_code_symbols, 1.5 s budget)
       ↓ fewer than `limit` hits
Vector fill: embed the query, match_repository_memory (one 3 s budget; keyword-only on any failure)
       ↓
Secret-scrubbed, size-limited structured results
       ↓
Realtime
```

- Results only come from the indexed Repository Context for the interview's commit SHA (see [Repository Context](#6-repository-context)).
- Secret scrubbing and secret-bearing-file exclusion apply to tool output exactly as they do to AI ingestion.
- File content is returned as clearly delimited data. Repository content is untrusted and cannot override interviewer instructions.
- Examined files are recorded as `evidence_examined` interview events, which feed report scope evidence. The payload is `{path, area?, tool}` plus an optional trace `{symbol?, startLine?, endLine?, commit_sha?}`, so every fact stays traceable to repository, commit, file, symbol and range. `record_evidence_examined` keeps each well-formed trace field and drops malformed ones individually; there is still one event per path per interview, keeping the first examination's range. The report lists the symbol and range next to the path.
- **Symbol hits.** Query terms are matched against the commit's `code_symbols` names (`search_code_symbols`: case-insensitive substring, ranked by matched terms, exported first, shorter names first). Hits carry `symbol`, `kind`, `startLine` and `endLine`, and an excerpt with the location, declaration and signature. They take at most half of `limit` unless keyword hits leave more room, so path and summary hits stay visible. A missing index returns no symbols; an error or the 1.5 s budget (`SYMBOL_SEARCH_BUDGET_MS`) logs `repository_search_symbol_fallback` and the search goes on without them. `code_module` rows are directory candidates; the `code_index` row is skipped.
- **`get_file` by symbol.** `symbol` (`name` or `Parent.name`, exact case first, then case-insensitive, first in source order) resolves through `code_symbols` to the declaration's lines at the pinned commit. Window limits and secret withholding are unchanged. When the file is indexed, the output lists the declarations overlapping the returned window. A failing code index never blocks a plain read.
- Symbol results are name-based and unresolved; the interviewer instructions say so, and the `find_*` functions are internal read capabilities, not Realtime tools.
- **Vector fill.** Keyword hits are always computed first and keep their rank, so path lookups stay precise. When they are fewer than `limit` and an embedding provider is configured, the query is embedded with `OPENAI_EMBEDDING_MODEL` and matched with `match_repository_memory` against the commit's embedded memory rows. Matches are appended after the keyword hits, ordered by similarity then kind, de-duplicated by path and area, until `limit`. Each is a row-level hit (`path: "."`, `area: kind`, scrubbed and clipped `content`), the same shape keyword search uses for summary rows, and is never recorded as `evidence_examined`. The query embedding is recorded in `ai_usage` with task `embedding` and the interview.
- **Latency budget.** The whole vector fill (query embedding, then the match, then mapping) shares one hard 3 s deadline (`VECTOR_SEARCH_BUDGET_MS`): both calls receive the same abort signal, and the fill is also raced against the deadline so the tool returns even if a client ignores the abort. Total added latency is never more than 3 s; typical cost is a few hundred milliseconds. On the deadline or any failure (no provider, provider error, dimension mismatch, match error, no embedded rows) the keyword hits are returned immediately, without a retry, and `repository_search_vector_fallback` is logged with a fixed `reason` (`deadline`, `embed_error`, `rpc_error`, `no_results`, `disabled`) and `elapsed_ms`. Vector search never fails the tool call.
- The match runs with the service client, which bypasses RLS, like every other tool read; the workspace and commit come from the already authorized interview, never from tool arguments.

### Server-decided mutations

Evaluations, coverage updates (via the `update_interview_state` database function, not a Realtime tool), and interview completion happen inside tool handlers, using the existing optimistic-concurrency version check.

`end_interview` is a request, not a command: the backend checks completion criteria (sufficient evidence or the ~30-minute target) before marking the interview `completed`. If accepted, it returns guidance for the interviewer to deliver a closing statement, then emits a `completion` event and triggers report generation. If rejected, it returns guidance to continue.

The candidate can pause or end the interview only through the authenticated, UI-confirmed `POST /interviews/:id/pause` and `POST /interviews/:id/end` (PRD §21), never through spoken intent. No Realtime tool can pause, and `end_interview` stays the interviewer's request, checked against completion criteria.

### Transcript persistence

Transcripts are persisted incrementally during the conversation, never only at the end. The Realtime session itself is ephemeral.

```text
Realtime transcription events (user + interviewer turns)
       ↓
Browser (buffer + retry until acknowledged)
       ↓
POST /interviews/:id/events   (idempotent: client event ID; backend assigns sequence)
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

- `interview_messages.sequence` and `interview_events.sequence` are both assigned by the **backend** as `max + 1` under a per-interview advisory lock. The browser never supplies a sequence; it only supplies `client_event_id`.
- The browser sends events one at a time in the order they were finalized, so server-assigned sequences follow conversation order.

`unique (interview_id, client_event_id)` makes retries idempotent, and `unique (interview_id, sequence)` guarantees no two rows share a position.

Tool calls are idempotent per `call_id`: a partial unique index on `(interview_id, payload->>'call_id')` for `tool_call` events ensures a relayed retry is executed once.

Schema: `tool_call`, `connected`, and `disconnected` event types, `interview_messages.client_event_id`, and the `call_id` index are added in migrations `20261004140000_realtime_event_types.sql` and `20261004140100_realtime_idempotency.sql`. Migration `20261005120000_transcript_events.sql` adds `interview_events.client_event_id` (partial unique index on `(interview_id, client_event_id)`) and the service-role-only functions `record_transcript_turn` and `record_voice_event` behind `POST /interviews/:id/events`. Connected/disconnected events are stored with the server's time; the browser's timestamp is kept in the payload.

The events endpoint returns `201` for a new row and `200` for a duplicate retry. A reused `client_event_id` with a different payload returns `409 event_conflict`. The acknowledgement returns `turn_sequence` (the assigned `interview_messages.sequence`) for transcript turns and `event_sequence` (the assigned `interview_events.sequence`) for voice events; both are informational for the browser. Turns are accepted after the interview has ended so buffered turns are not lost. A `voice_usage` event is stored in `ai_usage`, not `interview_events`, so its acknowledgement carries no sequence; a retry of a stored one returns `200` with status `duplicate` (see [Usage tracking](#usage-tracking)).

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

- Repository indexing (baseline analysis)
- Deep repository analysis
- Interview planning
- Report generation
- Other expensive AI operations

| Job type              | Trigger                                 | Output                                  |
| --------------------- | --------------------------------------- | --------------------------------------- |
| `repository_indexing` | Workspace created / analysis retried    | Baseline repository memory; workspace `ready` |
| `deep_analysis`       | Baseline analysis succeeded (best-effort chained step) | `structured.ai` on the commit's `architecture_summary` and `modules` rows, plus a `concepts` row |
| `code_indexing`       | Baseline analysis succeeded (best-effort chained step) | Commit-pinned `code_files` / `code_symbols` / `code_imports` / `code_calls`, `code_index` and `code_module` memory rows, symbol-outline `file_summary` rows |
| `interview_planning`  | `POST /workspaces/:id/interviews`       | Coverage map, plan, strategy in `interview_state` |
| `report_generation`   | Backend marks interview complete        | Interview report                        |

Memory embedding (Inngest event `repository.memory_embedding.requested`, function `memory-embedding`) also runs in the background, but it has no `jobs` row and no job type: it is triggered by best-effort steps after the baseline, after deep analysis and after the code index, keyed by the originating job's id, and its failures only reach logs and Sentry (see [Repository Context](#6-repository-context)).

### Implementation — Inngest

Background jobs run on **Inngest**. Supabase Edge Functions only send events; they do not execute long-running work.

```text
Supabase Edge Function
 ↓ (send event)
Inngest
 ↓
Inngest function (durable steps)
 ↓
GitHub App / OpenAI
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
- Rate-limit expensive AI endpoints: at most 5 interviews per user per rolling 24 hours, a 35-minute voice cap per interview, and integrity frames no faster than one per ~10 seconds
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
      GitHub / OpenAI
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
| `openAIEnvSchema`          | `OPENAI_API_KEY`, `OPENAI_REALTIME_MODEL`, `OPENAI_REALTIME_TRANSCRIPTION_MODEL`, `OPENAI_PLANNING_MODEL`, `OPENAI_EVALUATION_MODEL`, `OPENAI_VISION_MODEL`, `OPENAI_EMBEDDING_MODEL` (default `text-embedding-3-small`; must natively output 1536 dimensions). |
| `githubAppEnvSchema`       | `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_WEBHOOK_SECRET` |
| `edgeSentryEnvSchema`      | `SENTRY_DSN`, `SENTRY_ENVIRONMENT`                                                            |

Edge Functions read their variables with the `readEnv(name, schema)` helper in `supabase/functions/_shared/env.ts`.

Sentry is optional: an empty DSN disables it. The web app wires it through `apps/web/src/lib/sentry.ts` and the Next.js instrumentation files, and Edge Functions through `supabase/functions/_shared/sentry.ts`, which reports only thrown errors and caught internal failures, never expected 4xx outcomes.

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
