begin;

create extension if not exists pgtap with schema extensions;

select plan(27);

-- Fixtures (as postgres) ---------------------------------------------------------

insert into auth.users (id, email) values
  ('11111111-0000-4000-8000-000000000001', 'gina@example.com'),
  ('22222222-0000-4000-8000-000000000001', 'hank@example.com');

insert into public.repositories (id, user_id, github_repo_id, owner, name, full_name, is_private, default_branch) values
  ('11111111-0000-4000-8000-000000000003', '11111111-0000-4000-8000-000000000001', 5001, 'gina', 'app', 'gina/app', false, 'main'),
  ('11111111-0000-4000-8000-000000000013', '11111111-0000-4000-8000-000000000001', 5002, 'gina', 'api', 'gina/api', false, 'main'),
  ('11111111-0000-4000-8000-000000000023', '11111111-0000-4000-8000-000000000001', 5003, 'gina', 'cli', 'gina/cli', false, 'main'),
  ('22222222-0000-4000-8000-000000000003', '22222222-0000-4000-8000-000000000001', 5004, 'hank', 'web', 'hank/web', false, 'main');

insert into public.workspaces (id, user_id, repository_id, status, target_commit_sha, indexed_commit_sha, ready_at) values
  ('11111111-0000-4000-8000-000000000004', '11111111-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000003', 'ready', repeat('a', 40), repeat('a', 40), now()),
  ('11111111-0000-4000-8000-000000000014', '11111111-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000013', 'ready', repeat('b', 40), repeat('b', 40), now()),
  ('11111111-0000-4000-8000-000000000024', '11111111-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000023', 'analyzing', repeat('c', 40), null, null),
  ('22222222-0000-4000-8000-000000000004', '22222222-0000-4000-8000-000000000001', '22222222-0000-4000-8000-000000000003', 'ready', repeat('d', 40), repeat('d', 40), now());

create function pg_temp.start(p_workspace text, p_user text, p_sha text) returns integer language sql as $$
  select interview_number from public.start_interview(p_workspace::uuid, p_user::uuid, p_sha);
$$;

create function pg_temp.limit_detail() returns text language plpgsql as $$
declare
  v_detail text;
begin
  perform public.start_interview('11111111-0000-4000-8000-000000000014', '11111111-0000-4000-8000-000000000001', repeat('b', 40));
  return null;
exception when sqlstate 'P0429' then
  get stacked diagnostics v_detail = pg_exception_detail;
  return v_detail;
end;
$$;

-- Schema and privileges -----------------------------------------------------------

select ok('interview_planning' = any(enum_range(null::public.job_type)::text[]), 'job_type includes interview_planning');
select has_index('public', 'jobs', 'jobs_active_interview_planning_key', 'one active planning job per interview');
select ok(not has_function_privilege('authenticated', 'public.start_interview(uuid, uuid, text)', 'EXECUTE'), 'authenticated cannot execute start_interview');
select ok(not has_function_privilege('anon', 'public.start_interview(uuid, uuid, text)', 'EXECUTE'), 'anon cannot execute start_interview');
select ok(has_function_privilege('service_role', 'public.start_interview(uuid, uuid, text)', 'EXECUTE'), 'service_role can execute start_interview');
select ok(not (select prosecdef from pg_proc where proname = 'start_interview'), 'start_interview is security invoker');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "11111111-0000-4000-8000-000000000001", "role": "authenticated"}', true);
select throws_ok(
  $$select * from public.start_interview('11111111-0000-4000-8000-000000000004', '11111111-0000-4000-8000-000000000001', repeat('a', 40))$$,
  '42501', null, 'a signed-in user cannot call start_interview directly'
);
reset role;

-- Ownership and readiness -----------------------------------------------------------

set local role service_role;

select throws_ok(
  $$select * from public.start_interview('22222222-0000-4000-8000-000000000004', '11111111-0000-4000-8000-000000000001', repeat('d', 40))$$,
  'P0002', 'workspace_not_found', 'another user''s workspace is not found'
);
select throws_ok(
  $$select * from public.start_interview('99999999-0000-4000-8000-000000000004', '11111111-0000-4000-8000-000000000001', repeat('a', 40))$$,
  'P0002', 'workspace_not_found', 'an unknown workspace is not found'
);
select throws_ok(
  $$select * from public.start_interview('11111111-0000-4000-8000-000000000024', '11111111-0000-4000-8000-000000000001', repeat('c', 40))$$,
  '55000', 'workspace_not_ready', 'an analyzing workspace cannot start an interview'
);
select throws_ok(
  $$select * from public.start_interview('11111111-0000-4000-8000-000000000004', '11111111-0000-4000-8000-000000000001', repeat('e', 40))$$,
  '55000', 'workspace_not_ready', 'the expected commit must be the indexed commit'
);

-- Creation ----------------------------------------------------------------------------

create temp table started on commit drop as
select * from public.start_interview('11111111-0000-4000-8000-000000000004', '11111111-0000-4000-8000-000000000001', repeat('a', 40));

select is(
  (select interview_number::text || ':' || status::text from started),
  '1:created',
  'the first interview is number 1 and created'
);
select is(
  (select j.type::text || ':' || j.status::text || ':' || j.repository_commit_sha::text || ':' || j.user_id::text
   from public.jobs as j where j.id = (select job_id from started) and j.interview_id = (select interview_id from started)),
  'interview_planning:queued:' || repeat('a', 40) || ':11111111-0000-4000-8000-000000000001',
  'a queued planning job is created for the interview'
);
select is(
  (select repository_commit_sha::text from public.interviews where id = (select interview_id from started)),
  repeat('a', 40),
  'the interview is pinned to the indexed commit'
);
select is(
  (select version::text || ':' || plan::text || ':' || coverage_map::text from public.interview_state where interview_id = (select interview_id from started)),
  '1:{}:{}',
  'the interview starts with empty state at version 1'
);
select is(
  pg_temp.start('11111111-0000-4000-8000-000000000004', '11111111-0000-4000-8000-000000000001', repeat('a', 40)),
  2,
  'the next interview in the workspace is number 2'
);
select throws_ok(
  $$insert into public.jobs (user_id, workspace_id, interview_id, type, status)
    select user_id, workspace_id, id, 'interview_planning', 'running' from public.interviews where id = (select interview_id from started)$$,
  '23505', null, 'only one active planning job per interview'
);
select throws_ok(
  $$insert into public.jobs (user_id, workspace_id, type, status)
    values ('11111111-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000004', 'interview_planning', 'queued')$$,
  '23514', null, 'a planning job must reference an interview'
);
select lives_ok(
  $$update public.jobs set status = 'running', stage = 'planning' where id = (select job_id from started)$$,
  'jobs.stage accepts planning'
);

-- Rate limit: 5 per rolling 24 hours, across workspaces -----------------------------------

update public.interviews set created_at = now() - interval '25 hours'
where user_id = '11111111-0000-4000-8000-000000000001';

select is(
  pg_temp.start('11111111-0000-4000-8000-000000000004', '11111111-0000-4000-8000-000000000001', repeat('a', 40)),
  3,
  'interviews older than 24 hours do not count toward the limit'
);
select is(pg_temp.start('11111111-0000-4000-8000-000000000004', '11111111-0000-4000-8000-000000000001', repeat('a', 40)), 4, 'second in the window');
select is(pg_temp.start('11111111-0000-4000-8000-000000000014', '11111111-0000-4000-8000-000000000001', repeat('b', 40)), 1, 'numbers are per workspace');
select is(pg_temp.start('11111111-0000-4000-8000-000000000014', '11111111-0000-4000-8000-000000000001', repeat('b', 40)), 2, 'fourth in the window');
select is(pg_temp.start('11111111-0000-4000-8000-000000000014', '11111111-0000-4000-8000-000000000001', repeat('b', 40)), 3, 'fifth in the window');

select throws_ok(
  $$select * from public.start_interview('11111111-0000-4000-8000-000000000004', '11111111-0000-4000-8000-000000000001', repeat('a', 40))$$,
  'P0429', 'interview_limit_reached', 'a sixth interview in 24 hours is rejected'
);
select is(
  pg_temp.limit_detail()::timestamptz,
  now() + interval '24 hours',
  'the limit error reports when the next interview is allowed'
);
select is(
  pg_temp.start('22222222-0000-4000-8000-000000000004', '22222222-0000-4000-8000-000000000001', repeat('d', 40)),
  1,
  'the limit is per user'
);

reset role;

select * from finish();

rollback;
