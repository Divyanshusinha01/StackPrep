
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
| Voice               | **OpenAI Realtime API over WebRTC** | No separate voice provider; browser connects directly to OpenAI for audio |
| Voice credentials   | **Ephemeral Realtime credential minted by Edge Function** | `OPENAI_API_KEY` stays server-side; browser only gets a short-lived credential |
| Application communication | **HTTP + SSE**         | HTTP for commands/state; SSE for server-to-client interview events |
| Transcript storage  | **Supabase PostgreSQL (canonical)** | OpenAI Realtime runs the live session; StackPrep persists the interview record |
| Vision              | **OpenAI vision models**     | No CV infrastructure                                 |
| GitHub              | **GitHub App**               | Secure repository access                             |
| Parsing             | **Rule-based fact extraction** (Tree-sitter deferred) | Lightweight, runs in Edge Functions; adopt Tree-sitter if analysis needs deeper parsing |
| Validation          | **Zod**                      | Lightweight schema validation                        |
| Testing             | **Vitest + Playwright**      | Unit + E2E testing                                   |
| Monitoring          | **Sentry**                   | Error tracking; free tier initially                  |
| UI                  | **Tailwind + shadcn/ui**     | Fast product development                             |
| Animation           | **Framer Motion**            | UI/landing-page animations                           |


