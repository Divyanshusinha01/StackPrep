begin;

create extension if not exists pgtap with schema extensions;

select plan(16);

-- Fixtures ------------------------------------------------------------------

insert into auth.users (id, email) values
  ('88888888-0000-4000-8000-000000000001', 'kai@example.com'),
  ('88888888-0000-4000-8000-000000000002', 'lou@example.com');

insert into public.repositories (id, user_id, github_repo_id, owner, name, full_name, is_private, default_branch) values
  ('88888888-0000-4000-8000-000000000003', '88888888-0000-4000-8000-000000000001', 8001, 'kai', 'api', 'kai/api', false, 'main');

insert into public.workspaces (id, user_id, repository_id, status, indexed_commit_sha, ready_at) values
  ('88888888-0000-4000-8000-000000000004', '88888888-0000-4000-8000-000000000001', '88888888-0000-4000-8000-000000000003', 'ready', repeat('f', 40), now());

create function pg_temp.interview_id() returns uuid language sql as $$
  select id from public.interviews where workspace_id = '88888888-0000-4000-8000-000000000004';
$$;

create function pg_temp.request(p_user_id uuid default '88888888-0000-4000-8000-000000000001') returns uuid
language sql as $$
  select public.request_report(pg_temp.interview_id(), p_user_id);
$$;

-- Privileges --------------------------------------------------------------------------

select ok(not has_function_privilege('authenticated', 'public.request_report(uuid, uuid)', 'EXECUTE'), 'authenticated cannot execute request_report');
select ok(not has_function_privilege('authenticated', 'public.save_report(uuid, uuid, jsonb)', 'EXECUTE'), 'authenticated cannot execute save_report');
select ok(has_function_privilege('service_role', 'public.save_report(uuid, uuid, jsonb)', 'EXECUTE'), 'service_role can execute save_report');
select ok(
  not exists (select 1 from pg_proc where proname in ('request_report', 'save_report') and prosecdef),
  'the report functions are security invoker'
);

select lives_ok(
  $$select * from public.create_interview(
      '88888888-0000-4000-8000-000000000004', '88888888-0000-4000-8000-000000000001', repeat('f', 40), '{}', '{}', '{}')$$,
  'fixture interview is created'
);

set local role service_role;

-- request_report ------------------------------------------------------------------------

select is(pg_temp.request(), null, 'an interview that is not completed gets no report job');

reset role;
update public.interviews set status = 'completed', ended_at = now() where id = pg_temp.interview_id();
set local role service_role;

select is(pg_temp.request('88888888-0000-4000-8000-000000000002'), null, 'another user cannot request the report');
create temp table first_job as select pg_temp.request() as id;
select ok((select id is not null from first_job), 'a completed interview gets a queued report job');
select is(pg_temp.request(), null, 'a second request while one is active is a no-op');

-- save_report ---------------------------------------------------------------------------

select throws_ok(
  $$select public.save_report(pg_temp.interview_id(), (select id from first_job), '[]')$$,
  '22023', 'invalid_report_content', 'report content must be an object'
);
select throws_ok(
  $$select public.save_report(pg_temp.interview_id(), gen_random_uuid(), '{}')$$,
  'P0002', 'report_job_not_found', 'an unknown job cannot save a report'
);
select lives_ok(
  $$select public.save_report(pg_temp.interview_id(), (select id from first_job), '{"executive_summary": "v1"}')$$,
  'the report is saved'
);
select lives_ok(
  $$select public.save_report(pg_temp.interview_id(), (select id from first_job), '{"executive_summary": "v2"}')$$,
  'saving again is idempotent'
);
select is(
  (select content ->> 'executive_summary' from public.reports where interview_id = pg_temp.interview_id()),
  'v2',
  'one report row per interview, holding the latest content'
);
select is(
  (select status::text || ':' || progress from public.jobs where id = (select id from first_job)),
  'succeeded:100',
  'saving the report marks its job succeeded'
);
select is(pg_temp.request(), null, 'an interview with a report gets no new job');

reset role;

select * from finish();

rollback;
