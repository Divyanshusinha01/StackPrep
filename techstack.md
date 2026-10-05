
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
| AI                  | **OpenAI API**               | LLM + voice + vision                                 |
| Voice model         | **`gpt-realtime-2.1-mini`** (configurable) | Voice is ~90% of AI cost; mini keeps a 30-min interview cheap while the backend does the heavy reasoning |
| Text models         | **`gpt-5.6-luna`** for auxiliary extraction/classification; **`gpt-5.6-terra`** for deep analysis, planning, answer evaluation, and report (all configurable per task) | Cheap model for simple jobs; one stronger model for everything users judge |
| Voice               | **OpenAI Realtime API over WebRTC** | No separate voice provider; browser connects directly to OpenAI for audio |
| Voice credentials   | **Ephemeral Realtime credential minted by Edge Function** | `OPENAI_API_KEY` stays server-side; browser only gets a short-lived credential |
| Application communication | **HTTP + SSE**         | HTTP for commands/state; SSE for server-to-client interview events |
| Transcript storage  | **Supabase PostgreSQL (canonical)** | OpenAI Realtime runs the live session; StackPrep persists the interview record |
| Vision              | **`gpt-5.6-luna`, 1 low-detail frame every 10 s** | No CV infrastructure; frames are analyzed and discarded |
| GitHub              | **GitHub App**               | Secure repository access                             |
| Parsing             | **Rule-based fact extraction** (Tree-sitter deferred) | Lightweight, runs in Edge Functions; adopt Tree-sitter if analysis needs deeper parsing |
| Validation          | **Zod**                      | Lightweight schema validation                        |
| Testing             | **Vitest + Playwright**      | Unit + E2E testing                                   |
| Monitoring          | **Sentry**                   | Error tracking; free tier initially                  |
| UI                  | **Tailwind + shadcn/ui**     | Fast product development                             |
| Animation           | **Framer Motion**            | UI/landing-page animations                           |
| AI cost tracking    | **`ai_usage` table in Supabase PostgreSQL** | Per-call token and cost log; no external cost tool |

## AI cost targets

Model names live in environment variables, so models can change without code changes.

| Lever               | Decision                                                        |
| ------------------- | --------------------------------------------------------------- |
| Voice session length | Wrap-up at 30 min, hard stop at 35 min of connected voice time |
| Idle timeout        | Voice session closes after 3 min without candidate speech      |
| Usage limit         | Soft limit of 5 interviews per user per rolling 24 hours; no monthly quota |
| Voice context       | Stable cached prompt prefix; OpenAI auto-truncation during a session; compact summary on reconnect |
| Vision              | 1 low-detail frame every 10 s; frames never stored              |


