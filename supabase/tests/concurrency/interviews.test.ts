// Runs against a real database because it needs two sessions and real commits:
//   SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres pnpm test:db:concurrency
import { assertEquals, assertRejects } from "@std/assert";
import postgres from "postgres";

const dbUrl = Deno.env.get("SUPABASE_DB_URL");
const sha = "e".repeat(40);

async function withFixture(fn: (ctx: { a: postgres.Sql; b: postgres.Sql; userId: string; workspaceId: string }) => Promise<void>) {
  const a = postgres(dbUrl!, { max: 1, onnotice: () => {} });
  const b = postgres(dbUrl!, { max: 1, onnotice: () => {} });
  const userId = crypto.randomUUID();
  const repositoryId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  try {
    await a`insert into auth.users (id, email) values (${userId}, ${`${userId}@example.com`})`;
    await a`
      insert into public.repositories (id, user_id, github_repo_id, owner, name, full_name, is_private, default_branch)
      values (${repositoryId}, ${userId}, ${Math.floor(Math.random() * 1e9)}, 'test', 'repo', 'test/repo', false, 'main')`;
    await a`
      insert into public.workspaces (id, user_id, repository_id, status, indexed_commit_sha, ready_at)
      values (${workspaceId}, ${userId}, ${repositoryId}, 'ready', ${sha}, now())`;
    await fn({ a, b, userId, workspaceId });
  } finally {
    await a`delete from auth.users where id = ${userId}`;
    await Promise.all([a.end(), b.end()]);
  }
}

function settled(promise: Promise<unknown>) {
  const state = { done: false };
  promise.then(() => (state.done = true), () => (state.done = true));
  return state;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

Deno.test({
  name: "concurrent create_interview calls get distinct sequential interview numbers",
  ignore: !dbUrl,
  async fn() {
    await withFixture(async ({ a, b, userId, workspaceId }) => {
      const created = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();

      const first = a.begin(async (tx) => {
        const [row] = await tx`
          select interview_number from public.create_interview(${workspaceId}, ${userId}, ${sha}, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)`;
        created.resolve();
        await release.promise;
        return row.interview_number as number;
      });

      await created.promise;
      const second = b`
        select interview_number from public.create_interview(${workspaceId}, ${userId}, ${sha}, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)`
        .then(([row]) => row.interview_number as number);
      const secondState = settled(second);

      await delay(300);
      assertEquals(secondState.done, false, "second call should wait for the workspace lock");

      release.resolve();
      assertEquals(await Promise.all([first, second]), [1, 2]);
    });
  },
});

Deno.test({
  name: "concurrent updates with the same expected version: one wins, the other gets P0409",
  ignore: !dbUrl,
  async fn() {
    await withFixture(async ({ a, b, userId, workspaceId }) => {
      const [{ id: interviewId }] = await a`
        select id from public.create_interview(${workspaceId}, ${userId}, ${sha}, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)`;

      const updated = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();

      const first = a.begin(async (tx) => {
        const [row] = await tx`
          select public.update_interview_state(${interviewId}, 1, '{"writer": "a"}'::jsonb, '{}'::jsonb, '{}'::jsonb) as version`;
        updated.resolve();
        await release.promise;
        return Number(row.version);
      });

      await updated.promise;
      const second = b`
        select public.update_interview_state(${interviewId}, 1, '{"writer": "b"}'::jsonb, '{}'::jsonb, '{}'::jsonb) as version`;
      const secondState = settled(second);

      await delay(300);
      assertEquals(secondState.done, false, "second update should wait for the row lock");

      release.resolve();
      assertEquals(await first, 2);
      const error = await assertRejects(() => second) as { code?: string };
      assertEquals(error.code, "P0409");

      const [state] = await a`select version, coverage_map from public.interview_state where interview_id = ${interviewId}`;
      assertEquals(Number(state.version), 2);
      assertEquals(state.coverage_map, { writer: "a" });
    });
  },
});

Deno.test({
  name: "an interview inserted without state by the service role fails at commit",
  ignore: !dbUrl,
  async fn() {
    await withFixture(async ({ a, userId, workspaceId }) => {
      const error = await assertRejects(() =>
        a.begin(async (tx) => {
          await tx`set local role service_role`;
          await tx`
            insert into public.interviews (workspace_id, user_id, interview_number, repository_commit_sha)
            values (${workspaceId}, ${userId}, 1, ${sha})`;
        })
      ) as { code?: string; message?: string };
      assertEquals(error.code, "23514");
      assertEquals(error.message, "interview_missing_state");

      const [{ count }] = await a`select count(*)::int as count from public.interviews where workspace_id = ${workspaceId}`;
      assertEquals(count, 0);
    });
  },
});
