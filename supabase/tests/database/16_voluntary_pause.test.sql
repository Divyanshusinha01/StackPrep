begin;

create extension if not exists pgtap with schema extensions;

select plan(22);

-- Fixtures ------------------------------------------------------------------

insert into auth.users (id, email) values
  ('16161616-0000-4000-8000-000000000001', 'pia@example.com');

insert into public.repositories (id, user_id, github_repo_id, owner, name, full_name, is_private, default_branch) values
  ('16161616-0000-4000-8000-000000000003', '16161616-0000-4000-8000-000000000001', 1616, 'pia', 'api', 'pia/api', false, 'main');

insert into public.workspaces (id, user_id, repository_id, status, indexed_commit_sha, ready_at) values
  ('16161616-0000-4000-8000-000000000004', '16161616-0000-4000-8000-000000000001', '16161616-0000-4000-8000-000000000003', 'ready', repeat('e', 40), now());

create function pg_temp.interview_id() returns uuid language sql as $$
  select id from public.interviews where workspace_id = '16161616-0000-4000-8000-000000000004';
$$;

create function pg_temp.voice(p_client_event_id text, p_event_type text) returns text language sql as $$
  select status || ':' || sequence
  from public.record_voice_event(
    pg_temp.interview_id(), '16161616-0000-4000-8000-000000000001', p_client_event_id::uuid,
    p_event_type::public.event_type, '{}'::jsonb
  );
$$;

create function pg_temp.pause() returns text language sql as $$
  select status || ':' || pause_count || ':' || coalesce(disconnected_sequence::text, '-')
  from public.pause_interview(pg_temp.interview_id(), '16161616-0000-4000-8000-000000000001');
$$;

create function pg_temp.resume() returns text language sql as $$
  select status from public.resume_interview(pg_temp.interview_id(), '16161616-0000-4000-8000-000000000001');
$$;

-- Privileges --------------------------------------------------------------------------

select ok(not has_function_privilege('authenticated', 'public.pause_interview(uuid, uuid)', 'EXECUTE'), 'authenticated cannot execute pause_interview');
select ok(not has_function_privilege('authenticated', 'public.resume_interview(uuid, uuid)', 'EXECUTE'), 'authenticated cannot execute resume_interview');
select ok(has_function_privilege('service_role', 'public.pause_interview(uuid, uuid)', 'EXECUTE'), 'service_role can execute pause_interview');
select ok(has_function_privilege('service_role', 'public.resume_interview(uuid, uuid)', 'EXECUTE'), 'service_role can execute resume_interview');

set local role service_role;

select lives_ok(
  $$select * from public.create_interview(
      '16161616-0000-4000-8000-000000000004', '16161616-0000-4000-8000-000000000001', repeat('e', 40), '{}', '{}', '{}')$$,
  'fixture interview is created'
);

-- Pause -------------------------------------------------------------------------------

select is(pg_temp.pause(), 'not_active:0:-', 'an interview that has not started cannot be paused');
select is(pg_temp.voice('16161616-0000-4000-8000-0000000000a1', 'connected'), 'created:1', 'fixture: the candidate connects');
select is(pg_temp.pause(), 'paused:1:3', 'pausing closes the open voice segment with a server-side disconnect');
select ok(
  (select status = 'paused' and paused_at is not null and pause_count = 1 from public.interviews where id = pg_temp.interview_id()),
  'the interview is paused with a timestamp'
);
select is(
  (select payload from public.interview_events where interview_id = pg_temp.interview_id() and sequence = 4),
  '{"reason": "user"}'::jsonb,
  'a pause event records that the candidate paused'
);
select is(pg_temp.pause(), 'already_paused:1:-', 'pausing again while paused writes nothing');
select is(
  (select status from public.reserve_integrity_check(pg_temp.interview_id(), '16161616-0000-4000-8000-000000000001')),
  'not_active',
  'integrity frames are refused while paused'
);

-- Resume ------------------------------------------------------------------------------

select is(pg_temp.resume(), 'resumed', 'a paused interview resumes within the hour');
select ok(
  (select status = 'in_progress' and paused_at is null from public.interviews where id = pg_temp.interview_id()),
  'resuming clears the pause'
);
select is(pg_temp.resume(), 'already_active', 'resuming an active interview writes nothing');

-- Limit -------------------------------------------------------------------------------

select is(pg_temp.pause(), 'paused:2:-', 'a pause with no open voice segment writes no disconnect');
select is(pg_temp.resume(), 'resumed', 'fixture: resume after the second pause');
select is(pg_temp.pause(), 'paused:3:-', 'a third pause is allowed');
select is(pg_temp.resume(), 'resumed', 'fixture: resume after the third pause');
select is(pg_temp.pause(), 'limit_reached:3:-', 'a fourth pause is refused');

-- Expiry ------------------------------------------------------------------------------

update public.interviews set status = 'paused', paused_at = now() - interval '61 minutes' where id = pg_temp.interview_id();

select is(pg_temp.resume(), 'expired', 'a pause older than an hour cannot be resumed');
select ok(
  (select status = 'terminated' and termination_reason = 'user_abandoned' and ended_at is not null and paused_at is null
   from public.interviews where id = pg_temp.interview_id())
  and (select count(*) = 1 from public.interview_events where interview_id = pg_temp.interview_id() and event_type = 'termination'),
  'an expired pause terminates the interview as abandoned'
);

reset role;

select * from finish();

rollback;
