begin;

create extension if not exists pgtap with schema extensions;

select plan(37);

-- Fixtures (as postgres) ---------------------------------------------------------

insert into auth.users (id, email, raw_user_meta_data) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'alice@example.com', '{"user_name": "alice", "full_name": "Alice"}'),
  ('bbbbbbbb-0000-4000-8000-000000000001', 'bob@example.com', '{"user_name": "bob"}');

insert into public.github_connections (id, user_id, github_user_id, installation_id, account_login) values
  ('aaaaaaaa-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001', 1, 101, 'alice'),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'bbbbbbbb-0000-4000-8000-000000000001', 2, 102, 'bob');

insert into public.repositories (id, user_id, github_connection_id, github_repo_id, owner, name, full_name, is_private, default_branch) values
  ('aaaaaaaa-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000002', 1001, 'alice', 'app', 'alice/app', true, 'main'),
  ('bbbbbbbb-0000-4000-8000-000000000003', 'bbbbbbbb-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002', 1002, 'bob', 'api', 'bob/api', false, 'main');

insert into public.workspaces (id, user_id, repository_id, status, indexed_commit_sha, ready_at) values
  ('aaaaaaaa-0000-4000-8000-000000000004', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000003', 'ready', repeat('a', 40), now()),
  ('bbbbbbbb-0000-4000-8000-000000000004', 'bbbbbbbb-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000003', 'ready', repeat('b', 40), now());

insert into public.repository_memory (workspace_id, repository_id, user_id, repository_commit_sha, kind, content, embedding) values
  ('aaaaaaaa-0000-4000-8000-000000000004', 'aaaaaaaa-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-000000000001',
   repeat('a', 40), 'architecture_summary', 'Next.js frontend with Supabase backend',
   array_fill(0.1::real, array[1536])::extensions.vector),
  ('bbbbbbbb-0000-4000-8000-000000000004', 'bbbbbbbb-0000-4000-8000-000000000003', 'bbbbbbbb-0000-4000-8000-000000000001',
   repeat('b', 40), 'technologies', 'Go service', array_fill(0.2::real, array[1536])::extensions.vector);

select public.create_interview('aaaaaaaa-0000-4000-8000-000000000004', 'aaaaaaaa-0000-4000-8000-000000000001', repeat('a', 40), '{"backend": "untested"}', '{}', '{}');
select public.create_interview('bbbbbbbb-0000-4000-8000-000000000004', 'bbbbbbbb-0000-4000-8000-000000000001', repeat('b', 40), '{}', '{}', '{}');

insert into public.interview_messages (id, interview_id, user_id, sequence, role, content)
select ('aaaaaaaa-0000-4000-8000-00000000000' || n)::uuid, i.id, i.user_id, 1, 'ai', 'Explain your auth flow.'
from public.interviews as i
cross join lateral (select case when i.user_id = 'aaaaaaaa-0000-4000-8000-000000000001' then 5 else 6 end as n) as k;

insert into public.interview_events (interview_id, user_id, sequence, event_type)
select id, user_id, 1, 'start' from public.interviews;

insert into public.evaluations (interview_id, user_id, message_id, category, score)
select m.interview_id, m.user_id, m.id, 'security', 3 from public.interview_messages as m;

insert into public.reports (interview_id, workspace_id, user_id, content)
select id, workspace_id, user_id, '{"executive_summary": "..."}' from public.interviews;

insert into public.jobs (user_id, workspace_id, type, status, progress, stage)
select user_id, id, 'repository_indexing', 'running', 40, 'Scanning files' from public.workspaces;

-- Catalog-level privilege assertions ------------------------------------------------

select ok(
  (select bool_and(c.relrowsecurity) from pg_class as c
   join pg_namespace as n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'),
  'RLS is enabled on every public table'
);

select is(
  (select coalesce(array_agg(c.relname::text order by c.relname), '{}') from pg_class as c
   join pg_namespace as n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
     and has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')),
  '{}'::text[],
  'anon has no table privileges in public'
);

select is(
  (select coalesce(array_agg(c.relname::text order by c.relname), '{}') from pg_class as c
   join pg_namespace as n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
     and has_table_privilege('authenticated', c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')),
  '{}'::text[],
  'authenticated has no table-level write privileges in public'
);

select ok(not has_table_privilege('authenticated', 'public.interview_state', 'SELECT'), 'authenticated cannot select interview_state');
select ok(not has_table_privilege('anon', 'public.interview_state', 'SELECT'), 'anon cannot select interview_state');
select ok(not has_table_privilege('authenticated', 'public.evaluations', 'SELECT'), 'authenticated cannot select evaluations');
select ok(not has_table_privilege('anon', 'public.evaluations', 'SELECT'), 'anon cannot select evaluations');

select ok(
  not (select prosecdef from pg_proc where oid = 'public.match_repository_memory(uuid, extensions.vector, text, integer)'::regprocedure),
  'match_repository_memory is security invoker'
);
select ok(
  not has_function_privilege('anon', 'public.match_repository_memory(uuid, extensions.vector, text, integer)', 'EXECUTE'),
  'anon cannot execute match_repository_memory'
);
select ok(
  not has_function_privilege('authenticated', 'public.update_interview_state(uuid, bigint, jsonb, jsonb, jsonb)', 'EXECUTE'),
  'authenticated cannot execute update_interview_state'
);
select ok(
  not has_function_privilege('authenticated', 'public.create_interview(uuid, uuid, text, jsonb, jsonb, jsonb)', 'EXECUTE'),
  'authenticated cannot execute create_interview'
);

select is(
  (select github_login from public.profiles where id = 'aaaaaaaa-0000-4000-8000-000000000001'),
  'alice',
  'profile is created from auth.users metadata'
);

-- As Alice ------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "aaaaaaaa-0000-4000-8000-000000000001", "role": "authenticated"}', true);

select is((select count(*) from public.profiles), 1::bigint, 'Alice sees only her profile');
select is((select count(*) from public.github_connections), 1::bigint, 'Alice sees only her GitHub connection');
select is((select count(*) from public.repositories), 1::bigint, 'Alice sees only her repository');
select is((select count(*) from public.workspaces), 1::bigint, 'Alice sees only her workspace');
select is((select count(*) from public.repository_memory), 1::bigint, 'Alice sees only her repository memory');
select is((select count(*) from public.interviews), 1::bigint, 'Alice sees only her interview');
select is((select count(*) from public.interview_messages), 1::bigint, 'Alice sees only her messages');
select is((select count(*) from public.interview_events), 1::bigint, 'Alice sees only her events');
select is((select count(*) from public.reports), 1::bigint, 'Alice sees only her report');
select is((select count(*) from public.jobs), 1::bigint, 'Alice sees only her job');

select throws_ok('select * from public.interview_state', '42501', null, 'Alice cannot read interview_state');
select throws_ok('select * from public.evaluations', '42501', null, 'Alice cannot read evaluations');

select throws_ok(
  $$insert into public.workspaces (user_id, repository_id) values ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000003')$$,
  '42501', null, 'Alice cannot insert workspaces directly'
);
select throws_ok($$update public.interviews set status = 'completed'$$, '42501', null, 'Alice cannot update interviews');
select throws_ok($$delete from public.interview_messages$$, '42501', null, 'Alice cannot delete messages');
select throws_ok(
  $$update public.profiles set github_login = 'mallory' where id = 'aaaaaaaa-0000-4000-8000-000000000001'$$,
  '42501', null, 'Alice cannot change her github_login'
);

update public.profiles set display_name = 'Alice A.' where id = 'aaaaaaaa-0000-4000-8000-000000000001';
update public.profiles set display_name = 'hacked' where id = 'bbbbbbbb-0000-4000-8000-000000000001';

select is(
  (select count(*) from public.match_repository_memory(
    'aaaaaaaa-0000-4000-8000-000000000004', array_fill(0.1::real, array[1536])::extensions.vector, repeat('a', 40), 5)),
  1::bigint,
  'Alice retrieves memory from her own workspace'
);

-- As Bob --------------------------------------------------------------------

select set_config('request.jwt.claims', '{"sub": "bbbbbbbb-0000-4000-8000-000000000001", "role": "authenticated"}', true);

select is(
  (select count(*) from public.match_repository_memory(
    'aaaaaaaa-0000-4000-8000-000000000004', array_fill(0.1::real, array[1536])::extensions.vector, repeat('a', 40), 5)),
  0::bigint,
  'Bob gets no rows when calling match_repository_memory with Alice''s workspace'
);
select is(
  (select count(*) from public.interviews where user_id = 'aaaaaaaa-0000-4000-8000-000000000001'),
  0::bigint,
  'Bob cannot see Alice''s interviews'
);

-- As anon -------------------------------------------------------------------

set local role anon;
select set_config('request.jwt.claims', '{"role": "anon"}', true);

select throws_ok('select * from public.workspaces', '42501', null, 'anon cannot read workspaces');
select throws_ok(
  $$select * from public.match_repository_memory('aaaaaaaa-0000-4000-8000-000000000004', array_fill(0.1::real, array[1536])::extensions.vector, repeat('a', 40), 5)$$,
  '42501', null, 'anon cannot execute match_repository_memory'
);

-- Back to postgres: verify profile updates and immutability ------------------

reset role;

select is(
  (select display_name from public.profiles where id = 'aaaaaaaa-0000-4000-8000-000000000001'),
  'Alice A.',
  'Alice can update her own display_name'
);
select is(
  (select display_name from public.profiles where id = 'bbbbbbbb-0000-4000-8000-000000000001'),
  null,
  'Alice cannot update Bob''s profile'
);

set local role service_role;

select throws_ok(
  $$update public.interview_messages set content = 'edited'$$,
  '42501', null, 'interview_messages cannot be updated, even by the service role'
);
select throws_ok(
  $$update public.interview_events set payload = '{"edited": true}'$$,
  '42501', null, 'interview_events cannot be updated, even by the service role'
);

reset role;

select * from finish();

rollback;
