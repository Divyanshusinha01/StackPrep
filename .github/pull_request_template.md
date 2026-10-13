## What and why

<!-- What does this change do, and what problem does it solve? Link the issue if there is one. -->

## How it was tested

<!-- Commands run, new or updated tests, manual checks. -->

## Checklist

- [ ] `pnpm check` passes locally
- [ ] Tests added or updated at the right layer (Vitest, Deno, pgTAP, Playwright)
- [ ] Migrations and `pnpm db:types` updated if the schema changed
- [ ] `pnpm eval:replay` passes if prompts, retrieval or reports changed
- [ ] No secrets or real `.env` values committed
- [ ] Docs (README, `architecture.md`) updated if behaviour or configuration changed
