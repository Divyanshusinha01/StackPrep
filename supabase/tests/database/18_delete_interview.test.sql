begin;

create extension if not exists pgtap with schema extensions;

select plan(28);

-- Fixtures ------------------------------------------------------------------
-- Interview A is completed with a report, messages, events and jobs. In the second workspace,
-- B is in progress with an open voice segment, C is paused, D is pending and never deleted, and
-- E is pending.

insert into auth.users (id, email) values
  ('18181818-0000-4000-8000-000000000001', 'wes@example.com'),
  ('18181818-0000-4000-8000-000000000002', 'xia@example.com');

insert into public.repositories (id, user_id, github_repo_id, owner, name, full_name, is_private, default_branch) values
  ('18181818-0000-4000-8000-000000000003', '18181818-0000-4000-8000-000000000001', 1818, 'wes', 'api', 'wes/api', false, 'main'),
  ('18181818-0000-4000-8000-000000000013', '18181818-0000-4000-8000-000000000001', 1819, 'wes', 'web', 'wes/web', false, 'main');

insert into public.workspaces (id, user_id, repository_id, status, indexed_commit_sha, ready_at) values
  ('18181818-0000-4000-8000-000000000004', '18181818-0000-4000-8000-000000000001', '18181818-0000-4000-8000-000000000003', 'ready', repeat('f', 40), now()),
  ('18181818-0000-4000-8000-000000000014', '18181818-0000-4000-8000-000000000001', '18181818-0000-4000-8000-000000000013', 'ready', repeat('f', 40), now());

create function pg_temp.interview_id(p_key text) returns uuid language sql as $$
  select id from public.interviews
  where (p_key = 'a' and workspace_id = '18181818-0000-4000-8000-000000000004')
     or (
       workspace_id = '18181818-0000-4000-8000-000000000014'
       and interview_number = case p_key when 'b' then 1 when 'c' then 2 when 'd' then 3 when 'e' then 4 end
     );
$$;

create function pg_temp.delete_interview(p_key text, p_user_id text default '18181818-0000-4000-8000-000000000001')
returns text language sql as $$
  select d.status from public.delete_interview(pg_temp.interview_id(p_key), p_user_id::uuid) as d;
$$;

select * from public.create_interview(
  '18181818-0000-4000-8000-000000000004', '18181818-0000-4000-8000-000000000001', repeat('f', 40), '{}', '{}', '{}');
select * from public.create_interview(
  '18181818-0000-4000-8000-000000000014', '18181818-0000-4000-8000-000000000001', repeat('f', 40), '{}', '{}', '{}');
select * from public.create_interview(
  '18181818-0000-4000-8000-000000000014', '18181818-0000-4000-8000-000000000001', repeat('f', 40), '{}', '{}', '{}');
select * from public.create_interview(
  '18181818-0000-4000-8000-000000000014', '18181818-0000-4000-8000-000000000001', repeat('f', 40), '{}', '{}', '{}');
select * from public.create_interview(
  '18181818-0000-4000-8000-000000000014', '18181818-0000-4000-8000-000000000001', repeat('f', 40), '{}', '{}', '{}');

update public.interviews set status = 'completed', ended_at = now() where id = pg_temp.interview_id('a');
update public.interviews set status = 'in_progress' where id = pg_temp.interview_id('b');

insert into public.interview_messages (interview_id, user_id, sequence, role, content)
values (pg_temp.interview_id('a'), '18181818-0000-4000-8000-000000000001', 1, 'user', 'We use JWTs.');
insert into public.interview_events (interview_id, user_id, sequence, event_type, payload)
values (pg_temp.interview_id('a'), '18181818-0000-4000-8000-000000000001', 1, 'connected', '{}');
insert into public.interview_events (interview_id, user_id, sequence, event_type, payload)
values (pg_temp.interview_id('b'), '18181818-0000-4000-8000-000000000001', 1, 'connected', '{}');
insert into public.reports (interview_id, workspace_id, user_id, content)
values (pg_temp.interview_id('a'), '18181818-0000-4000-8000-000000000004', '18181818-0000-4000-8000-000000000001', '{"executive_summary": "..."}');
insert into public.jobs (user_id, workspace_id, interview_id, type, status)
values ('18181818-0000-4000-8000-000000000001', '18181818-0000-4000-8000-000000000004', pg_temp.interview_id('a'), 'report_generation', 'succeeded');
insert into public.jobs (user_id, workspace_id, type, status, repository_commit_sha)
values ('18181818-0000-4000-8000-000000000001', '18181818-0000-4000-8000-000000000004', 'repository_indexing', 'succeeded', repeat('f', 40));

-- Privileges --------------------------------------------------------------------------

select ok(not has_function_privilege('authenticated', 'public.delete_interview(uuid, uuid)', 'EXECUTE'), 'authenticated cannot execute delete_interview');
select ok(not has_function_privilege('anon', 'public.delete_interview(uuid, uuid)', 'EXECUTE'), 'anon cannot execute delete_interview');
select ok(has_function_privilege('service_role', 'public.delete_interview(uuid, uuid)', 'EXECUTE'), 'service_role can execute delete_interview');

-- Delete ------------------------------------------------------------------------------

set local role service_role;

select is(pg_temp.delete_interview('a', '18181818-0000-4000-8000-000000000002'), 'not_found', 'another user cannot delete the interview');
select is(
  (select d.status from public.delete_interview(gen_random_uuid(), '18181818-0000-4000-8000-000000000001') as d),
  'not_found',
  'an unknown interview is not found'
);
select is(pg_temp.delete_interview('a'), 'deleted', 'an ended interview is deleted');
select ok(
  (select deleted_at is not null and status = 'completed' from public.interviews where id = pg_temp.interview_id('a')),
  'the row is kept with deleted_at set and its status unchanged'
);
select is(
  (select count(*)::int from public.interview_events where interview_id = pg_temp.interview_id('a')),
  1,
  'deleting an ended interview writes no events'
);
select is(pg_temp.delete_interview('a'), 'already_deleted', 'deleting it again writes nothing');
select is(
  (select count(*)::int from public.interviews where workspace_id = '18181818-0000-4000-8000-000000000004'),
  1,
  'service role still sees the deleted interview'
);
select is(
  (select count(*)::int from public.reports where interview_id = pg_temp.interview_id('a')),
  1,
  'the report is not removed'
);

select is(
  (select row(d.status, d.disconnected_sequence)::text from public.delete_interview(pg_temp.interview_id('b'), '18181818-0000-4000-8000-000000000001') as d),
  '(deleted,2)',
  'an interview in progress is deleted and its open voice segment is closed'
);
select ok(
  (select deleted_at is not null and status = 'terminated' and termination_reason = 'user_abandoned'
     and ended_at is not null and paused_at is null
   from public.interviews where id = pg_temp.interview_id('b')),
  'the interview in progress is terminated as user_abandoned before it is deleted'
);
select is(
  array(select event_type::text || ':' || (payload->>'source') from public.interview_events
        where interview_id = pg_temp.interview_id('b') and sequence > 1 order by sequence),
  array['disconnected:user_delete', 'termination:user_delete'],
  'the voice segment is closed and a termination is recorded'
);

update public.interviews set status = 'paused', paused_at = now() where id = pg_temp.interview_id('c');
select is(pg_temp.delete_interview('c'), 'deleted', 'a paused interview is deleted');
select ok(
  (select deleted_at is not null and status = 'terminated' and paused_at is null
   from public.interviews where id = pg_temp.interview_id('c')),
  'the paused interview is terminated before it is deleted'
);
select is(
  array(select event_type::text from public.interview_events where interview_id = pg_temp.interview_id('c') order by sequence),
  array['termination'],
  'with no open voice segment only the termination is recorded'
);

select is(pg_temp.delete_interview('e'), 'deleted', 'a pending interview is deleted');
select ok(
  (select deleted_at is not null and status = 'terminated' from public.interviews where id = pg_temp.interview_id('e')),
  'the pending interview is terminated, so it can no longer be started'
);

reset role;

-- Owner visibility --------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "18181818-0000-4000-8000-000000000001", "role": "authenticated"}', true);

select is(
  (select count(*)::int from public.interviews where id = pg_temp.interview_id('a')),
  0,
  'the owner no longer sees the deleted interview'
);
select is(
  (select count(*)::int from public.interviews where id = pg_temp.interview_id('d')),
  1,
  'the owner still sees other interviews'
);
select is(
  (select count(*)::int from public.interview_messages),
  0,
  'messages of the deleted interview are hidden'
);
select is(
  (select count(*)::int from public.interview_events),
  0,
  'events of the deleted interviews are hidden'
);
select is(
  (select count(*)::int from public.reports),
  0,
  'the report of the deleted interview is hidden'
);
select is(
  (select count(*)::int from public.jobs where type = 'report_generation'),
  0,
  'jobs of the deleted interview are hidden'
);
select is(
  (select count(*)::int from public.jobs where type = 'repository_indexing'),
  1,
  'workspace jobs stay visible'
);
select throws_ok(
  $$select * from public.delete_interview('18181818-0000-4000-8000-000000000001', '18181818-0000-4000-8000-000000000001')$$,
  '42501', null, 'authenticated cannot call delete_interview'
);

reset role;

select ok(
  (select deleted_at is not null from public.interviews where id = pg_temp.interview_id('a')),
  'the interview stays deleted'
);

select * from finish();

rollback;
