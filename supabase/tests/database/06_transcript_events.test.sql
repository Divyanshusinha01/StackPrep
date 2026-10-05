begin;

create extension if not exists pgtap with schema extensions;

select plan(27);

-- Fixtures ------------------------------------------------------------------

insert into auth.users (id, email) values
  ('66666666-0000-4000-8000-000000000001', 'ivy@example.com');

insert into public.repositories (id, user_id, github_repo_id, owner, name, full_name, is_private, default_branch) values
  ('66666666-0000-4000-8000-000000000003', '66666666-0000-4000-8000-000000000001', 6001, 'ivy', 'api', 'ivy/api', false, 'main');

insert into public.workspaces (id, user_id, repository_id, status, indexed_commit_sha, ready_at) values
  ('66666666-0000-4000-8000-000000000004', '66666666-0000-4000-8000-000000000001', '66666666-0000-4000-8000-000000000003', 'ready', repeat('f', 40), now());

create function pg_temp.turn(p_client_event_id text, p_role text, p_content text)
returns text language sql as $$
  select status || ':' || sequence
  from public.record_transcript_turn(
    (select id from public.interviews where workspace_id = '66666666-0000-4000-8000-000000000004'),
    '66666666-0000-4000-8000-000000000001', p_client_event_id::uuid, p_role::public.message_role,
    p_content, '{"item_id": "item_1"}'
  );
$$;

create function pg_temp.voice(p_client_event_id text, p_event_type text)
returns text language sql as $$
  select status || ':' || sequence
  from public.record_voice_event(
    (select id from public.interviews where workspace_id = '66666666-0000-4000-8000-000000000004'),
    '66666666-0000-4000-8000-000000000001', p_client_event_id::uuid, p_event_type::public.event_type,
    '{"client_occurred_at": "2020-01-01T00:00:00Z"}'
  );
$$;

-- Schema and privileges -------------------------------------------------------------

select has_index('public', 'interview_events', 'interview_events_client_event_id_key', 'interview_events has a client_event_id index');

select ok(not has_function_privilege('authenticated', 'public.record_transcript_turn(uuid, uuid, uuid, public.message_role, text, jsonb)', 'EXECUTE'), 'authenticated cannot execute record_transcript_turn');
select ok(not has_function_privilege('anon', 'public.record_transcript_turn(uuid, uuid, uuid, public.message_role, text, jsonb)', 'EXECUTE'), 'anon cannot execute record_transcript_turn');
select ok(has_function_privilege('service_role', 'public.record_transcript_turn(uuid, uuid, uuid, public.message_role, text, jsonb)', 'EXECUTE'), 'service_role can execute record_transcript_turn');
select ok(not has_function_privilege('authenticated', 'public.record_voice_event(uuid, uuid, uuid, public.event_type, jsonb)', 'EXECUTE'), 'authenticated cannot execute record_voice_event');
select ok(not has_function_privilege('anon', 'public.record_voice_event(uuid, uuid, uuid, public.event_type, jsonb)', 'EXECUTE'), 'anon cannot execute record_voice_event');
select ok(has_function_privilege('service_role', 'public.record_voice_event(uuid, uuid, uuid, public.event_type, jsonb)', 'EXECUTE'), 'service_role can execute record_voice_event');
select ok(
  not exists (select 1 from pg_proc where proname in ('record_transcript_turn', 'record_voice_event') and prosecdef),
  'both functions are security invoker'
);

set local role service_role;

select lives_ok(
  $$select * from public.create_interview(
      '66666666-0000-4000-8000-000000000004', '66666666-0000-4000-8000-000000000001', repeat('f', 40), '{}', '{}', '{}')$$,
  'fixture interview is created'
);

-- Transcript turns -----------------------------------------------------------------

select is(pg_temp.turn('66666666-0000-4000-8000-0000000000a1', 'ai', 'How is auth handled?'), 'created:1', 'the first turn gets sequence 1');
select is(pg_temp.turn('66666666-0000-4000-8000-0000000000a1', 'ai', 'How is auth handled?'), 'duplicate:1', 'a retry returns duplicate with the stored sequence');
select is(pg_temp.turn('66666666-0000-4000-8000-0000000000a1', 'ai', 'Something else'), 'event_conflict:1', 'a reused event id with different content conflicts');
select is(pg_temp.turn('66666666-0000-4000-8000-0000000000a1', 'user', 'How is auth handled?'), 'event_conflict:1', 'a reused event id with a different role conflicts');
select is(pg_temp.turn('66666666-0000-4000-8000-0000000000a2', 'user', 'JWTs.'), 'created:2', 'the server assigns the next turn sequence');
select is(
  (select count(*)::int from public.interview_messages as m join public.interviews as i on i.id = m.interview_id
   where i.workspace_id = '66666666-0000-4000-8000-000000000004'),
  2,
  'retries and conflicts store nothing'
);
select lives_ok(
  $$insert into public.interview_messages (interview_id, user_id, sequence, role, content)
    select id, user_id, 3, 'system', 'server note'
    from public.interviews where workspace_id = '66666666-0000-4000-8000-000000000004'$$,
  'fixture: a server-written message takes sequence 3'
);
select is(pg_temp.turn('66666666-0000-4000-8000-0000000000a3', 'user', 'Sessions too.'), 'created:4', 'turns continue after rows the client never saw');
select is(
  (select metadata ->> 'item_id' from public.interview_messages where client_event_id = '66666666-0000-4000-8000-0000000000a1'),
  'item_1',
  'turn metadata is stored'
);
select throws_ok(
  $$select pg_temp.turn('66666666-0000-4000-8000-0000000000a9', 'system', 'note')$$,
  '22023', 'invalid_transcript_role', 'system turns cannot be recorded'
);

-- Voice events ---------------------------------------------------------------------

select is(pg_temp.voice('66666666-0000-4000-8000-0000000000b1', 'connected'), 'created:1', 'connected gets the first event sequence');
select is(pg_temp.voice('66666666-0000-4000-8000-0000000000b1', 'connected'), 'duplicate:1', 'a connected retry returns duplicate');
select is(pg_temp.voice('66666666-0000-4000-8000-0000000000b1', 'disconnected'), 'event_conflict:1', 'a reused event id with another type conflicts');
select is(pg_temp.voice('66666666-0000-4000-8000-0000000000b2', 'disconnected'), 'created:2', 'the server assigns the next event sequence');
select is(
  (select occurred_at from public.interview_events where client_event_id = '66666666-0000-4000-8000-0000000000b1'),
  now(),
  'voice events use the server clock, not the client''s'
);
select throws_ok(
  $$select pg_temp.voice('66666666-0000-4000-8000-0000000000b3', 'tool_call')$$,
  '22023', 'invalid_voice_event_type', 'only connected and disconnected can be recorded'
);
select throws_ok(
  $$insert into public.interview_events (interview_id, user_id, sequence, event_type, client_event_id)
    select id, user_id, 10, 'connected', '66666666-0000-4000-8000-0000000000b1'
    from public.interviews where workspace_id = '66666666-0000-4000-8000-000000000004'$$,
  '23505', null, 'a client_event_id is stored at most once per interview'
);
select lives_ok(
  $$insert into public.interview_events (interview_id, user_id, sequence, event_type)
    select id, user_id, s, 'start'
    from public.interviews, generate_series(11, 12) as s where workspace_id = '66666666-0000-4000-8000-000000000004'$$,
  'server-written events without a client_event_id are unaffected'
);

reset role;

select * from finish();

rollback;
