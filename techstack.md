
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
| Voice               | **OpenAI Realtime + WebRTC** | No separate voice provider                           |
| Vision              | **OpenAI vision models**     | No CV infrastructure                                 |
| GitHub              | **GitHub App**               | Secure repository access                             |
| Parsing             | **Tree-sitter**              | Local/open-source parsing                            |
| Validation          | **Zod**                      | Lightweight schema validation                        |
| Testing             | **Vitest + Playwright**      | Unit + E2E testing                                   |
| Monitoring          | **Sentry**                   | Error tracking; free tier initially                  |
| UI                  | **Tailwind + shadcn/ui**     | Fast product development                             |
| Animation           | **Framer Motion**            | UI/landing-page animations                           |


