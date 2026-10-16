begin;

create extension if not exists pgtap with schema extensions;

select plan(12);

-- Fixtures ------------------------------------------------------------------

insert into auth.users (id, email) values
  ('19190000-0000-4000-8000-000000000001', 'ivy@example.com'),
  ('19190000-0000-4000-8000-000000000002', 'jon@example.com');

insert into public.repositories (id, user_id, github_repo_id, owner, name, full_name, is_private, default_branch) values
  ('19190000-0000-4000-8000-000000000003', '19190000-0000-4000-8000-000000000001', 1919, 'ivy', 'api', 'ivy/api', false, 'main');

insert into public.workspaces (id, user_id, repository_id, status, indexed_commit_sha, ready_at) values
  ('19190000-0000-4000-8000-000000000004', '19190000-0000-4000-8000-000000000001', '19190000-0000-4000-8000-000000000003', 'ready', repeat('e', 40), now());

create function pg_temp.interview_id() returns uuid language sql as $$
  select id from public.interviews where workspace_id = '19190000-0000-4000-8000-000000000004';
$$;

create function pg_temp.upgrade(p_user_id uuid default '19190000-0000-4000-8000-000000000001') returns uuid
language sql as $$
  select public.request_report_upgrade(pg_temp.interview_id(), p_user_id);
$$;

-- Privileges ----------------------------------------------------------------

select ok(
  not has_function_privilege('authenticated', 'public.request_report_upgrade(uuid, uuid)', 'EXECUTE'),
  'authenticated cannot execute request_report_upgrade'
);
select ok(
  not exists (select 1 from pg_proc where proname = 'request_report_upgrade' and prosecdef),
  'request_report_upgrade is security invoker'
);

select lives_ok(
  $$select * from public.create_interview(
      '19190000-0000-4000-8000-000000000004', '19190000-0000-4000-8000-000000000001', repeat('e', 40), '{}', '{}', '{}')$$,
  'fixture interview is created'
);

set local role service_role;

select is(pg_temp.upgrade(), null, 'an interview that is not completed cannot be upgraded');

reset role;
update public.interviews set status = 'completed', ended_at = now() where id = pg_temp.interview_id();
set local role service_role;

select is(pg_temp.upgrade(), null, 'a completed interview without a report cannot be upgraded');

create temp table first_job as select public.request_report(pg_temp.interview_id(), '19190000-0000-4000-8000-000000000001') as id;
select public.save_report(pg_temp.interview_id(), (select id from first_job), '{"executive_summary": "legacy"}');

select is(pg_temp.upgrade('19190000-0000-4000-8000-000000000002'), null, 'another user cannot upgrade the report');

create temp table upgrade_job as select pg_temp.upgrade() as id;
select is(
  (select type::text || ':' || status::text from public.jobs where id = (select id from upgrade_job)),
  'report_generation:queued',
  'a legacy report gets a queued report job'
);
select is(pg_temp.upgrade(), null, 'a second upgrade while one is active is a no-op');
select is(
  (select content ->> 'executive_summary' from public.reports where interview_id = pg_temp.interview_id()),
  'legacy',
  'the legacy report stays readable while the upgrade runs'
);

select lives_ok(
  $$select public.save_report(pg_temp.interview_id(), (select id from upgrade_job),
    '{"report_version": 2, "executive_summary": "learning", "question_reviews": [], "concepts": []}')$$,
  'the upgrade job saves a learning report'
);
select is(
  (select count(*)::text || ':' || max(content ->> 'report_version') from public.reports where interview_id = pg_temp.interview_id()),
  '1:2',
  'the learning report replaces the legacy one in the same row'
);
select is(pg_temp.upgrade(), null, 'a learning report cannot be upgraded again');

reset role;

select * from finish();

rollback;
