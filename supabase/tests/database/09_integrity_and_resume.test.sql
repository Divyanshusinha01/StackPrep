begin;

create extension if not exists pgtap with schema extensions;

select plan(43);

-- Fixtures ------------------------------------------------------------------

insert into auth.users (id, email) values
  ('99999999-0000-4000-8000-000000000001', 'iris@example.com');

insert into public.repositories (id, user_id, github_repo_id, owner, name, full_name, is_private, default_branch) values
  ('99999999-0000-4000-8000-000000000003', '99999999-0000-4000-8000-000000000001', 9001, 'iris', 'api', 'iris/api', false, 'main');

insert into public.workspaces (id, user_id, repository_id, status, indexed_commit_sha, ready_at) values
  ('99999999-0000-4000-8000-000000000004', '99999999-0000-4000-8000-000000000001', '99999999-0000-4000-8000-000000000003', 'ready', repeat('f', 40), now());

create function pg_temp.interview_id() returns uuid language sql as $$
  select id from public.interviews where workspace_id = '99999999-0000-4000-8000-000000000004';
$$;

create function pg_temp.voice(p_client_event_id text, p_event_type text, p_payload jsonb default '{}')
returns text language sql as $$
  select status || ':' || sequence
  from public.record_voice_event(
    pg_temp.interview_id(), '99999999-0000-4000-8000-000000000001', p_client_event_id::uuid,
    p_event_type::public.event_type, p_payload
  );
$$;

create temp table checks (name text primary key, id uuid);
grant select, insert on checks to service_role;

-- now() is fixed inside the test transaction, so p_age moves earlier reservations out of the
-- 10 s window first.
create function pg_temp.age_checks() returns void language plpgsql as $$
declare
  r public.interview_events;
begin
  for r in
    select * from public.interview_events
    where interview_id = pg_temp.interview_id() and event_type = 'integrity_check' and not (payload ? 'check_id')
  loop
    delete from public.interview_events where id = r.id;
    insert into public.interview_events (id, interview_id, user_id, sequence, event_type, payload, occurred_at)
    values (r.id, r.interview_id, r.user_id, r.sequence, r.event_type, r.payload, r.occurred_at - interval '11 seconds');
  end loop;
end;
$$;

create function pg_temp.reserve(p_name text default null, p_age boolean default false) returns text language plpgsql as $$
declare
  v_status text;
  v_id uuid;
begin
  if p_age then
    perform pg_temp.age_checks();
  end if;
  select status, check_id into v_status, v_id
  from public.reserve_integrity_check(pg_temp.interview_id(), '99999999-0000-4000-8000-000000000001');
  if p_name is not null and v_id is not null then
    insert into checks values (p_name, v_id);
  end if;
  return v_status;
end;
$$;

create function pg_temp.signal(p_name text, p_kind text default null) returns text language sql as $$
  select status || coalesce(':' || warning_number, '')
  from public.record_integrity_signal(
    pg_temp.interview_id(), '99999999-0000-4000-8000-000000000001', (select id from checks where name = p_name), p_kind
  );
$$;

create function pg_temp.event_count(p_type text) returns integer language sql as $$
  select count(*)::int from public.interview_events
  where interview_id = pg_temp.interview_id() and event_type = p_type::public.event_type;
$$;

-- Privileges --------------------------------------------------------------------------

select ok(not has_function_privilege('authenticated', 'public.reserve_integrity_check(uuid, uuid)', 'EXECUTE'), 'authenticated cannot execute reserve_integrity_check');
select ok(not has_function_privilege('anon', 'public.reserve_integrity_check(uuid, uuid)', 'EXECUTE'), 'anon cannot execute reserve_integrity_check');
select ok(has_function_privilege('service_role', 'public.reserve_integrity_check(uuid, uuid)', 'EXECUTE'), 'service_role can execute reserve_integrity_check');
select ok(not has_function_privilege('authenticated', 'public.record_integrity_signal(uuid, uuid, uuid, text)', 'EXECUTE'), 'authenticated cannot execute record_integrity_signal');
select ok(not has_function_privilege('anon', 'public.record_integrity_signal(uuid, uuid, uuid, text)', 'EXECUTE'), 'anon cannot execute record_integrity_signal');
select ok(has_function_privilege('service_role', 'public.record_integrity_signal(uuid, uuid, uuid, text)', 'EXECUTE'), 'service_role can execute record_integrity_signal');
select ok(not has_function_privilege('authenticated', 'public.record_voice_event(uuid, uuid, uuid, public.event_type, jsonb)', 'EXECUTE'), 'record_voice_event stays service-role only after widening');
select ok(
  not exists (select 1 from pg_proc where proname in ('reserve_integrity_check', 'record_integrity_signal', 'record_voice_event') and prosecdef),
  'the functions are security invoker'
);

set local role service_role;

select lives_ok(
  $$select * from public.create_interview(
      '99999999-0000-4000-8000-000000000004', '99999999-0000-4000-8000-000000000001', repeat('f', 40), '{}', '{}', '{}')$$,
  'fixture interview is created'
);

-- Reservation gating -------------------------------------------------------------------

select is(pg_temp.reserve(), 'not_active', 'frames are refused before the interview starts');
select is(pg_temp.voice('99999999-0000-4000-8000-0000000000a1', 'connected'), 'created:1', 'fixture: the candidate connects');
select is(pg_temp.reserve('c1'), 'reserved', 'a connected interview accepts a frame');
select is(pg_temp.reserve(), 'rate_limited', 'a second frame within 10 seconds is refused');
select is(pg_temp.event_count('integrity_check'), 1, 'a refused frame stores nothing');

-- Resolution ---------------------------------------------------------------------------

select is(pg_temp.signal('c1'), 'clear', 'a frame without a signal resolves clear');
select is(pg_temp.signal('c1', 'looking_away'), 'clear', 'resolving again returns the first outcome');
select is(pg_temp.event_count('integrity_check'), 2, 'the reservation and its resolution are separate events');
select is((select integrity_warning_count from public.interviews where id = pg_temp.interview_id()), 0::smallint, 'a clear frame issues no warning');
select is(pg_temp.reserve(), 'rate_limited', 'a clear frame still counts toward the rate limit');
select throws_ok(
  $$select * from public.record_integrity_signal(pg_temp.interview_id(), '99999999-0000-4000-8000-000000000001', gen_random_uuid(), null)$$,
  'P0002', 'integrity_check_not_found', 'an unknown check cannot be resolved'
);
select throws_ok(
  $$select pg_temp.signal('c1', 'bad_lighting')$$,
  '22023', 'invalid_integrity_signal', 'unknown signal kinds are rejected'
);

-- Pause / resume -----------------------------------------------------------------------

select is(
  pg_temp.voice('99999999-0000-4000-8000-0000000000a2', 'pause', '{"reason": "camera"}'),
  'created:5',
  'a pause is stored with the next sequence'
);
select is(pg_temp.voice('99999999-0000-4000-8000-0000000000a2', 'pause', '{"reason": "camera"}'), 'duplicate:5', 'a retried pause is a duplicate');
select is(pg_temp.voice('99999999-0000-4000-8000-0000000000a2', 'resume'), 'event_conflict:5', 'a pause id reused for a resume conflicts');
select is(
  (select payload ->> 'reason' from public.interview_events where interview_id = pg_temp.interview_id() and event_type = 'pause'),
  'camera',
  'the pause keeps its reason'
);
select is(pg_temp.reserve(null, true), 'interrupted', 'frames are refused while paused');
select is(pg_temp.voice('99999999-0000-4000-8000-0000000000a3', 'resume'), 'created:6', 'a resume is stored');
select is(pg_temp.reserve('c2'), 'reserved', 'frames are accepted again after resume');
select throws_ok(
  $$select pg_temp.voice('99999999-0000-4000-8000-0000000000a4', 'start')$$,
  '22023', 'invalid_voice_event_type', 'clients cannot record other event types'
);

-- Warnings and termination ---------------------------------------------------------------

select is(pg_temp.signal('c2', 'looking_away'), 'warning:1', 'the first signal is warning 1');
select is(pg_temp.signal('c2', 'looking_away'), 'warning:1', 'a retried signal does not warn twice');
select is(
  (select payload - 'check_id' from public.interview_events where interview_id = pg_temp.interview_id() and event_type = 'integrity_warning'),
  '{"kind": "looking_away", "warning_number": 1}'::jsonb,
  'the warning stores only the kind and number'
);

select is(pg_temp.voice('99999999-0000-4000-8000-0000000000a5', 'disconnected'), 'created:9', 'fixture: the connection drops');
select is(pg_temp.reserve(null, true), 'interrupted', 'frames are refused while disconnected');
select is(pg_temp.voice('99999999-0000-4000-8000-0000000000a6', 'connected'), 'created:10', 'fixture: the candidate reconnects');
select is(pg_temp.reserve('c3'), 'reserved', 'a reconnected interview accepts frames');
select is(pg_temp.signal('c3', 'device_or_notes'), 'warning:2', 'the second signal is warning 2');

select is(pg_temp.reserve('c4', true), 'reserved', 'fixture: a third frame is reserved');
select is(pg_temp.reserve('c5', true), 'reserved', 'fixture: a fourth frame is reserved while the third is analyzed');
select is(pg_temp.signal('c4', 'other_person'), 'terminated:3', 'the third signal terminates the interview');
select ok(
  (select status = 'terminated' and termination_reason = 'integrity_violation' and ended_at is not null and integrity_warning_count = 3
   from public.interviews where id = pg_temp.interview_id())
  and pg_temp.event_count('termination') = 1,
  'termination sets the status, reason, and end time and emits one termination event'
);
select is(pg_temp.signal('c5', 'face_absent'), 'not_active', 'a frame resolved after termination is a no-op');
select is(pg_temp.reserve(null, true), 'not_active', 'frames are refused after termination');

reset role;

select * from finish();

rollback;
