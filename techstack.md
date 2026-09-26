# StackPrep Tech Stack

| Component | Choice | Reason |
|---|---|---|
| Frontend | **Next.js** | One codebase, excellent DX |
| Frontend hosting | **Vercel** | Easiest deployment |
| Backend | **Hono + Node.js** | Small, fast, TypeScript-native |
| Backend hosting | **Render** | Simple Git deployment |
| Database | **Supabase PostgreSQL** | Free tier + managed Postgres |
| Auth | **Supabase Auth** | No auth infrastructure to maintain |
| Storage | **Supabase Storage** | Avoid another service |
| Vector DB | **pgvector** | Runs inside PostgreSQL |
| Cache | **None initially** | Remove unnecessary infrastructure |
| Workers | **Render Background Worker** | Repository indexing/report generation |
| AI | **OpenAI API** | LLM + voice + vision |
| Voice | **OpenAI Realtime + WebRTC** | No separate voice provider |
| Vision | **OpenAI vision models** | No CV infrastructure |
| GitHub | **GitHub App** | Repository access |
| Parsing | **Tree-sitter** | Local/open-source |
| Validation | **Zod** | Lightweight |
| Testing | **Vitest + Playwright** | Simple |
| Monitoring | **Sentry** | Start with free tier |
| UI | **Tailwind + shadcn/ui** | Fast product development |
| Animation | **Motion** | Enough for the landing page |
