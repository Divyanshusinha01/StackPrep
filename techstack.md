
| Component           | Choice                       | Reason                                               |
| ------------------- | ---------------------------- | ---------------------------------------------------- |
| Frontend            | **Next.js**                  | One codebase, excellent DX                           |
| Frontend hosting    | **Vercel**                   | Easiest deployment                                   |
| Backend             | **Supabase Edge Functions**  | Serverless TypeScript backend                        |
| Backend hosting     | **Supabase**                 | Same platform as database, auth, and storage         |
| Database            | **Supabase PostgreSQL**      | Managed PostgreSQL                                   |
| Auth                | **Supabase Auth**            | No separate auth infrastructure                      |
| Storage             | **Supabase Storage**         | Integrated storage                                   |
| Vector DB           | **pgvector**                 | Runs inside PostgreSQL                               |
| Cache               | **None initially**           | Avoid unnecessary infrastructure                     |
| **Background jobs** | **Inngest**                  | Durable serverless jobs; free tier, no card required |
| AI                  | **OpenAI API**, on each user's own API key | LLM + voice + vision. Users bring their own key and OpenAI bills them directly; there is no platform key |
| Voice model         | **`gpt-realtime-2.1-mini`** (configurable) | Voice is ~90% of AI cost; mini keeps a 30-min interview cheap while the backend does the heavy reasoning |
| Transcription model | **`gpt-live-transcribe`** (configurable via `OPENAI_REALTIME_TRANSCRIPTION_MODEL`) | Transcribes only the candidate's speech, in a second, transcription-only WebRTC session on the same microphone track (committed per turn by the browser; see architecture); the interviewer's transcript comes free from the voice model. Billed at $0.017 per minute of audio. Replaces `gpt-4o-mini-transcribe`, which OpenAI removes on **Feb 26, 2027** |
| Text models         | **`gpt-6.1-sol`** for planning and deep analysis (deep analysis reuses `OPENAI_PLANNING_MODEL`); **`gpt-6-luna`** for answer evaluation (`OPENAI_EVALUATION_MODEL`) and the report (`OPENAI_REPORT_MODEL`); all configurable per task | The stronger model prepares the interview once per run; the faster, cheaper model scores answers while the candidate waits and writes the report |
| Web search          | **OpenAI Responses API `web_search` tool**, on the user's own key (`OPENAI_REPORT_SEARCH_MODEL`, defaults to the report model) | Finds learning resources for the report's concepts. No separate search vendor or secret; only links returned in the tool's citations are shown |
| Embeddings          | **`text-embedding-3-small`** (configurable via `OPENAI_EMBEDDING_MODEL`) | Embeds repository memory rows and `search_repository` queries for pgvector retrieval. The model must natively output the 1536 dimensions the `vector(1536)` column requires; output is never truncated implicitly |
| Voice               | **OpenAI Realtime API over WebRTC** | No separate voice provider; browser connects directly to OpenAI for audio |
| Voice credentials   | **Ephemeral Realtime credential minted by Edge Function** | Minted with the user's decrypted key, which stays server-side; browser only gets a short-lived credential |
| User key encryption | **AES-256-GCM via Web Crypto in Edge Functions**, versioned master keys in Supabase function secrets (`OPENAI_KEY_ENCRYPTION_KEYS`) | No extra KMS or vault service; ciphertext in PostgreSQL is bound to its user and row, and the master keys never touch the database |
| Application communication | **HTTP + SSE**         | HTTP for commands/state. SSE (`GET /interviews/:id/events`, fetch-based reader with a composite `Last-Event-ID` cursor) for interview events: `interview_status`, `turn_persisted`, `report_ready`. 4 s polling (`use-poll-while.ts`) for analysis progress, lobby readiness, and pending reports, and as the fallback when the stream fails |
| Transcript storage  | **Supabase PostgreSQL (canonical)** | OpenAI Realtime runs the live session; StackPrep persists the interview record |
| Vision              | **`gpt-6-luna`, 1 low-detail frame every 10 s** | No CV infrastructure; frames are analyzed and discarded |
| GitHub              | **GitHub App**               | Secure repository access                             |
| Parsing             | **Tree-sitter (`web-tree-sitter` WASM)** via `packages/code-parser`, plus rule-based baseline extraction | Syntactic code facts (symbols, imports, calls) for TypeScript/TSX, JavaScript/JSX, Python, Java, Go, C and C++, linked into a path-based cross-file call graph; runs in the Inngest Edge Function, verified on hosted Supabase Edge. The rule-based extractor still produces the baseline and covers files Tree-sitter does not parse |
| Validation          | **Zod**                      | Lightweight schema validation                        |
| Testing             | **Vitest + Playwright**      | Unit + E2E testing                                   |
| Monitoring          | **Sentry**                   | Error tracking; free tier initially                  |
| Analytics           | **Vercel Web Analytics** (`@vercel/analytics`) | Cookieless and aggregate, so no consent banner; same platform as hosting. Page views on all plans; custom events (`cta_click`, `login_started`, `workspace_created`, `interview_started`, `report_viewed`, via `lib/analytics.ts`) need a paid Vercel plan, otherwise the CTA-to-`/login` funnel is read from path views. Event properties never carry repository names, paths or transcript text |
| UI                  | **Tailwind + shadcn/ui**     | Fast product development                             |
| Animation           | **Framer Motion**            | UI/landing-page animations                           |
| AI cost tracking    | **`ai_usage` table in Supabase PostgreSQL** | Per-call token and estimated cost log on users' keys, attributed to the key used; no external cost tool |

## AI cost targets

Model names live in environment variables, so models can change without code changes. All usage is billed to the user's own OpenAI key, so these levers keep each interview affordable for the user.

| Lever               | Decision                                                        |
| ------------------- | --------------------------------------------------------------- |
| Voice session length | Wrap-up at 30 min, hard stop at 35 min of connected voice time |
| Idle timeout        | Voice session closes after 3 min without candidate speech      |
| Usage limit         | Fair-use limit of 5 interviews per user per rolling 24 hours; no monthly quota. The user's own spend cap is their OpenAI usage limit |
| Voice context       | Stable cached prompt prefix; OpenAI auto-truncation during a session; compact summary on reconnect |
| Vision              | 1 low-detail frame every 10 s; frames never stored              |


