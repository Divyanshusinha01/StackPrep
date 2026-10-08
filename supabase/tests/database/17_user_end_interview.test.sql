begin;

create extension if not exists pgtap with schema extensions;

select plan(18);

-- Fixtures ------------------------------------------------------------------
-- Interview A is paused and has no evaluated answer; interview B is live with one.

insert into auth.users (id, email) values
  ('17171717-0000-4000-8000-000000000001', 'uma@example.com'),
  ('17171717-0000-4000-8000-000000000002', 'vic@example.com');

insert into public.repositories (id, user_id, github_repo_id, owner, name, full_name, is_private, default_branch) values
  ('17171717-0000-4000-8000-000000000003', '17171717-0000-4000-8000-000000000001', 1717, 'uma', 'api', 'uma/api', false, 'main'),
  ('17171717-0000-4000-8000-000000000013', '17171717-0000-4000-8000-000000000001', 1718, 'uma', 'web', 'uma/web', false, 'main');

insert into public.workspaces (id, user_id, repository_id, status, indexed_commit_sha, ready_at) values
  ('17171717-0000-4000-8000-000000000004', '17171717-0000-4000-8000-000000000001', '17171717-0000-4000-8000-000000000003', 'ready', repeat('f', 40), now()),
  ('17171717-0000-4000-8000-000000000014', '17171717-0000-4000-8000-000000000001', '17171717-0000-4000-8000-000000000013', 'ready', repeat('f', 40), now());

create function pg_temp.interview_id(p_workspace text) returns uuid language sql as $$
  select id from public.interviews
  where workspace_id = case p_workspace
    when 'a' then '17171717-0000-4000-8000-000000000004'::uuid
    else '17171717-0000-4000-8000-000000000014'::uuid
  end;
$$;

create function pg_temp.connect(p_workspace text, p_client_event_id text) returns text language sql as $$
  select status || ':' || sequence
  from public.record_voice_event(
    pg_temp.interview_id(p_workspace), '17171717-0000-4000-8000-000000000001', p_client_event_id::uuid,
    'connected', '{}'::jsonb
  );
$$;

create function pg_temp.end_interview(p_workspace text, p_user_id text default '17171717-0000-4000-8000-000000000001')
returns text language sql as $$
  select status || ':' || coalesce(disconnected_sequence::text, '-')
  from public.end_interview_by_user(pg_temp.interview_id(p_workspace), p_user_id::uuid);
$$;

-- Privileges --------------------------------------------------------------------------

select ok(not has_function_privilege('authenticated', 'public.end_interview_by_user(uuid, uuid)', 'EXECUTE'), 'authenticated cannot execute end_interview_by_user');
select ok(has_function_privilege('service_role', 'public.end_interview_by_user(uuid, uuid)', 'EXECUTE'), 'service_role can execute end_interview_by_user');

set local role service_role;

select lives_ok(
  $$select * from public.create_interview(
      '17171717-0000-4000-8000-000000000004', '17171717-0000-4000-8000-000000000001', repeat('f', 40), '{}', '{}', '{}')$$,
  'fixture interview A is created'
);
select lives_ok(
  $$select * from public.create_interview(
      '17171717-0000-4000-8000-000000000014', '17171717-0000-4000-8000-000000000001', repeat('f', 40), '{}', '{}', '{}')$$,
  'fixture interview B is created'
);

-- Not started -------------------------------------------------------------------------

select is(pg_temp.end_interview('a'), 'not_active:-', 'an interview that has not started cannot be ended');

-- Paused, no evaluated answer ---------------------------------------------------------

select is(pg_temp.connect('a', '17171717-0000-4000-8000-0000000000a1'), 'created:1', 'fixture: A connects');
select is(
  (select status from public.pause_interview(pg_temp.interview_id('a'), '17171717-0000-4000-8000-000000000001')),
  'paused',
  'fixture: A is paused'
);
select is(pg_temp.end_interview('a', '17171717-0000-4000-8000-000000000002'), 'not_active:-', 'another user cannot end the interview');
select is(pg_temp.end_interview('a'), 'no_report:-', 'ending with no evaluated answer gives no report');
select ok(
  (select status = 'terminated' and termination_reason = 'user_abandoned' and paused_at is null and ended_at is not null
   from public.interviews where id = pg_temp.interview_id('a')),
  'the paused interview is terminated as abandoned and the pause is cleared'
);
select is(
  (select payload from public.interview_events
   where interview_id = pg_temp.interview_id('a') and event_type = 'termination'),
  '{"reason": "user_abandoned", "source": "user_end"}'::jsonb,
  'a termination event records that the candidate ended it'
);
select is(pg_temp.end_interview('a'), 'already_terminated:-', 'ending it again writes nothing');

-- In progress, with an evaluated answer -----------------------------------------------

select is(pg_temp.connect('b', '17171717-0000-4000-8000-0000000000b1'), 'created:1', 'fixture: B connects');

insert into public.interview_messages (id, interview_id, user_id, sequence, role, content)
values ('17171717-0000-4000-8000-0000000000c1', pg_temp.interview_id('b'), '17171717-0000-4000-8000-000000000001', 1, 'user', 'We use JWTs.');
insert into public.evaluations (interview_id, user_id, message_id, category, score)
values (pg_temp.interview_id('b'), '17171717-0000-4000-8000-000000000001', '17171717-0000-4000-8000-0000000000c1', 'security', 3);

select is(pg_temp.end_interview('b'), 'completed:3', 'ending a live interview closes the open voice segment and completes it');
select ok(
  (select status = 'completed' and termination_reason = 'user_ended' and ended_at is not null
   from public.interviews where id = pg_temp.interview_id('b')),
  'the interview is completed as ended by the candidate'
);
select is(
  (select array_agg(event_type::text || ' ' || payload::text order by sequence) from public.interview_events
   where interview_id = pg_temp.interview_id('b') and sequence >= 3),
  array['disconnected {"source": "user_end"}', 'completion {"reason": "user_ended"}'],
  'a server-side disconnect and a completion event are written'
);
select is(pg_temp.end_interview('b'), 'already_completed:-', 'ending a completed interview again writes nothing');
select isnt(
  public.request_report(pg_temp.interview_id('b'), '17171717-0000-4000-8000-000000000001'),
  null,
  'a report can be requested for the ended interview'
);

reset role;

select * from finish();

rollback;
