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
  name: "concurrent start_interview calls are serialized and each gets its own planning job",
  ignore: !dbUrl,
  async fn() {
    await withFixture(async ({ a, b, userId, workspaceId }) => {
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();

      const first = a.begin(async (tx) => {
        const [row] = await tx`
          select interview_number, job_id from public.start_interview(${workspaceId}, ${userId}, ${sha})`;
        started.resolve();
        await release.promise;
        return row as { interview_number: number; job_id: string };
      });

      await started.promise;
      const second = b`
        select interview_number, job_id from public.start_interview(${workspaceId}, ${userId}, ${sha})`
        .then(([row]) => row as { interview_number: number; job_id: string });
      const secondState = settled(second);

      await delay(300);
      assertEquals(secondState.done, false, "second call should wait for the per-user lock");

      release.resolve();
      const rows = await Promise.all([first, second]);
      assertEquals(rows.map((r) => r.interview_number), [1, 2]);

      const [{ count }] = await a`
        select count(*)::int as count from public.jobs
        where workspace_id = ${workspaceId} and type = 'interview_planning' and status = 'queued'`;
      assertEquals(count, 2);
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
  name: "concurrent voice events are serialized and get distinct event sequences",
  ignore: !dbUrl,
  async fn() {
    await withFixture(async ({ a, b, userId, workspaceId }) => {
      const [{ id: interviewId }] = await a`
        select id from public.create_interview(${workspaceId}, ${userId}, ${sha}, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)`;
      const recorded = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();

      const first = a.begin(async (tx) => {
        const [row] = await tx`
          select status, sequence from public.record_voice_event(
            ${interviewId}, ${userId}, ${crypto.randomUUID()}, 'connected', '{}'::jsonb)`;
        recorded.resolve();
        await release.promise;
        return row as { status: string; sequence: number };
      });

      await recorded.promise;
      const second = b`
        select status, sequence from public.record_voice_event(
          ${interviewId}, ${userId}, ${crypto.randomUUID()}, 'disconnected', '{}'::jsonb)`
        .then(([row]) => row as { status: string; sequence: number });
      const secondState = settled(second);

      await delay(300);
      assertEquals(secondState.done, false, "second event should wait for the per-interview lock");

      release.resolve();
      const rows = await Promise.all([first, second]);
      // The first connected also writes the interview's `start` event at sequence 2.
      assertEquals(rows.map((r) => `${r.status}:${r.sequence}`), ["created:1", "created:3"]);
    });
  },
});

Deno.test({
  name: "concurrent tool calls with the same call_id execute once; concurrent completions complete once",
  ignore: !dbUrl,
  async fn() {
    await withFixture(async ({ a, b, userId, workspaceId }) => {
      const [{ id: interviewId }] = await a`
        select id from public.create_interview(${workspaceId}, ${userId}, ${sha}, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)`;
      await a`select * from public.record_voice_event(${interviewId}, ${userId}, ${crypto.randomUUID()}, 'connected', '{}'::jsonb)`;

      const tool = (sql: postgres.Sql | postgres.TransactionSql) =>
        sql`
          select status from public.record_tool_call(
            ${interviewId}, ${userId}, 'call_1', 'end_interview', '{"reason": "time_target"}'::jsonb,
            '{"accepted": true}'::jsonb, '{"ok": true, "accepted": true, "guidance": "Close."}'::jsonb, null, null)`
          .then(([row]) => row.status as string);
      const complete = (sql: postgres.Sql | postgres.TransactionSql) =>
        sql`select public.complete_interview(${interviewId}, ${userId}, null) as done`.then(([row]) => row.done as boolean);

      const held = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const first = a.begin(async (tx) => {
        const result = [await complete(tx), await tool(tx)];
        held.resolve();
        await release.promise;
        return result;
      });

      await held.promise;
      const second = Promise.all([complete(b), tool(b)]);
      const secondState = settled(second);
      await delay(300);
      assertEquals(secondState.done, false, "second caller should wait for the per-interview lock");

      release.resolve();
      assertEquals(await first, [true, "created"]);
      assertEquals(await second, [false, "duplicate"]);
      const [{ count }] = await a`
        select count(*)::int as count from public.interview_events
        where interview_id = ${interviewId} and event_type = 'completion'`;
      assertEquals(count, 1);
    });
  },
});

Deno.test({
  name: "concurrent transcript turns: a retry returns duplicate, a different turn gets the next sequence",
  ignore: !dbUrl,
  async fn() {
    await withFixture(async ({ a, b, userId, workspaceId }) => {
      const firstEventId = crypto.randomUUID();
      const rounds = [
        { eventId: firstEventId, content: "It uses Postgres.", expected: "duplicate:1", stored: 1 },
        { eventId: crypto.randomUUID(), content: "Another turn.", expected: "created:2", stored: 2 },
      ];
      for (const { eventId, content, expected, stored } of rounds) {
        const [{ id: interviewId }] = await a`
          select id from public.create_interview(${workspaceId}, ${userId}, ${sha}, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)`;
        const turn = (sql: postgres.Sql | postgres.TransactionSql, id: string, text: string) =>
          sql`
            select status, sequence from public.record_transcript_turn(
              ${interviewId}, ${userId}, ${id}, 'user', ${text}, '{}'::jsonb)`
            .then(([row]) => `${row.status}:${row.sequence}`);

        const inserted = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const first = a.begin(async (tx) => {
          const result = await turn(tx, firstEventId, "It uses Postgres.");
          inserted.resolve();
          await release.promise;
          return result;
        });

        await inserted.promise;
        const second = turn(b, eventId, content);
        const secondState = settled(second);

        await delay(300);
        assertEquals(secondState.done, false, "second turn should wait for the per-interview lock");

        release.resolve();
        assertEquals(await first, "created:1");
        assertEquals(await second, expected);

        const [{ count }] = await a`
          select count(*)::int as count from public.interview_messages where interview_id = ${interviewId}`;
        assertEquals(count, stored);
      }
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
