begin;

create extension if not exists pgtap with schema extensions;

select plan(12);

-- Fixtures ------------------------------------------------------------------

insert into auth.users (id, email) values
  ('bb000000-0000-4000-8000-000000000001', 'vic@example.com'),
  ('bb000000-0000-4000-8000-000000000002', 'wes@example.com');

insert into public.repositories (id, user_id, github_repo_id, owner, name, full_name, is_private, default_branch) values
  ('bb000000-0000-4000-8000-000000000003', 'bb000000-0000-4000-8000-000000000001', 11001, 'vic', 'api', 'vic/api', false, 'main'),
  ('bb000000-0000-4000-8000-000000000005', 'bb000000-0000-4000-8000-000000000002', 11002, 'wes', 'api', 'wes/api', false, 'main');

insert into public.workspaces (id, user_id, repository_id, status, indexed_commit_sha, ready_at) values
  ('bb000000-0000-4000-8000-000000000004', 'bb000000-0000-4000-8000-000000000001', 'bb000000-0000-4000-8000-000000000003', 'ready', repeat('a', 40), now()),
  ('bb000000-0000-4000-8000-000000000006', 'bb000000-0000-4000-8000-000000000002', 'bb000000-0000-4000-8000-000000000005', 'ready', repeat('a', 40), now());

-- A 1536-dimension vector whose first two components are (x, y) and the rest zero.
create function pg_temp.vec(p_x real, p_y real) returns extensions.vector language sql as $$
  select (array[p_x, p_y] || array_fill(0::real, array[1534]))::extensions.vector;
$$;

create function pg_temp.memory(p_workspace uuid, p_sha text, p_kind text, p_embedding extensions.vector)
returns void language sql as $$
  insert into public.repository_memory (workspace_id, repository_id, user_id, repository_commit_sha, kind, content, embedding)
  select w.id, w.repository_id, w.user_id, p_sha, p_kind, p_kind || ' content', p_embedding
  from public.workspaces as w where w.id = p_workspace;
$$;

select pg_temp.memory('bb000000-0000-4000-8000-000000000004', repeat('a', 40), 'architecture_summary', pg_temp.vec(1, 0));
select pg_temp.memory('bb000000-0000-4000-8000-000000000004', repeat('a', 40), 'technologies', pg_temp.vec(0.8, 0.6));
select pg_temp.memory('bb000000-0000-4000-8000-000000000004', repeat('a', 40), 'modules', pg_temp.vec(0, 1));
select pg_temp.memory('bb000000-0000-4000-8000-000000000004', repeat('a', 40), 'key_files', null);
-- Exact matches that must never be returned: another commit and another user's workspace.
select pg_temp.memory('bb000000-0000-4000-8000-000000000004', repeat('b', 40), 'architecture_summary', pg_temp.vec(1, 0));
select pg_temp.memory('bb000000-0000-4000-8000-000000000006', repeat('a', 40), 'architecture_summary', pg_temp.vec(1, 0));

create function pg_temp.match(p_workspace uuid, p_count integer) returns table (kind text) language sql as $$
  select kind from public.match_repository_memory(p_workspace, pg_temp.vec(1, 0), repeat('a', 40), p_count);
$$;

set local role service_role;

-- match_repository_memory --------------------------------------------------------------

select is(
  (select array_agg(kind) from pg_temp.match('bb000000-0000-4000-8000-000000000004', 10)),
  array['architecture_summary', 'technologies', 'modules'],
  'rows are ordered by similarity, scoped to the workspace and commit, and null embeddings are skipped'
);
select is(
  (select array_agg(round(similarity::numeric, 3) order by similarity desc)
   from public.match_repository_memory('bb000000-0000-4000-8000-000000000004', pg_temp.vec(1, 0), repeat('a', 40), 10)),
  array[1.000, 0.800, 0.000]::numeric[],
  'similarity is one minus the cosine distance'
);
select is(
  (select array_agg(kind) from pg_temp.match('bb000000-0000-4000-8000-000000000006', 10)),
  array['architecture_summary'],
  'another workspace only sees its own rows'
);
select is(
  (select count(*)::int from public.match_repository_memory('bb000000-0000-4000-8000-000000000004', pg_temp.vec(1, 0), repeat('c', 40), 10)),
  0,
  'a commit without embedded rows returns nothing'
);
select is((select count(*)::int from pg_temp.match('bb000000-0000-4000-8000-000000000004', 0)), 1, 'a count below 1 is clamped to 1');
select is((select count(*)::int from pg_temp.match('bb000000-0000-4000-8000-000000000004', 2)), 2, 'the count limits the rows');
select is((select count(*)::int from pg_temp.match('bb000000-0000-4000-8000-000000000004', 1000)), 3, 'a large count is clamped and returns every embedded row');
select is((select count(*)::int from pg_temp.match('bb000000-0000-4000-8000-000000000004', null)), 3, 'a null count uses the default');
select is(
  pg_get_function_result('public.match_repository_memory(uuid, extensions.vector, text, integer)'::regprocedure),
  'TABLE(id uuid, kind text, content text, structured jsonb, metadata jsonb, similarity double precision)',
  'the vector itself is never returned'
);

-- Embedding writes ---------------------------------------------------------------------

select lives_ok(
  $$update public.repository_memory set embedding = pg_temp.vec(0.6, 0.8)
    where workspace_id = 'bb000000-0000-4000-8000-000000000004' and repository_commit_sha = repeat('a', 40) and kind = 'key_files'$$,
  'a 1536-dimension embedding is stored'
);
select throws_ok(
  $$update public.repository_memory set embedding = '[0.1, 0.2, 0.3]'
    where workspace_id = 'bb000000-0000-4000-8000-000000000004' and repository_commit_sha = repeat('a', 40) and kind = 'modules'$$,
  '22000', null, 'an embedding of another dimension is rejected'
);

-- ai_usage task ------------------------------------------------------------------------

select lives_ok(
  $$insert into public.ai_usage (user_id, workspace_id, task, model, source, input_tokens, idempotency_key)
    values ('bb000000-0000-4000-8000-000000000001', 'bb000000-0000-4000-8000-000000000004', 'embedding',
            'text-embedding-3-small', 'provider', 42, 'embedding:test')$$,
  'ai_usage accepts the embedding task'
);

reset role;

select * from finish();

rollback;
