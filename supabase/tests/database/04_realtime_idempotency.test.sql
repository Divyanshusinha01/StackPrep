begin;

create extension if not exists pgtap with schema extensions;

select plan(8);

-- Fixtures ------------------------------------------------------------------

insert into auth.users (id, email) values
  ('eeeeeeee-0000-4000-8000-000000000001', 'erin@example.com');

insert into public.repositories (id, user_id, github_repo_id, owner, name, full_name, is_private, default_branch) values
  ('eeeeeeee-0000-4000-8000-000000000003', 'eeeeeeee-0000-4000-8000-000000000001', 4001, 'erin', 'api', 'erin/api', false, 'main');

insert into public.workspaces (id, user_id, repository_id, status, indexed_commit_sha, ready_at) values
  ('eeeeeeee-0000-4000-8000-000000000004', 'eeeeeeee-0000-4000-8000-000000000001', 'eeeeeeee-0000-4000-8000-000000000003', 'ready', repeat('e', 40), now());

set local role service_role;

create temp table created on commit drop as
select * from public.create_interview(
  'eeeeeeee-0000-4000-8000-000000000004', 'eeeeeeee-0000-4000-8000-000000000001', repeat('e', 40), '{}', '{}', '{}'
);

-- Transcript turns -------------------------------------------------------------

insert into public.interview_messages (interview_id, user_id, sequence, role, content, client_event_id)
select id, user_id, 1, 'ai', 'How is auth handled?', 'eeeeeeee-0000-4000-8000-0000000000a1' from created;

select throws_ok(
  format(
    $$insert into public.interview_messages (interview_id, user_id, sequence, role, content, client_event_id)
      values (%L, 'eeeeeeee-0000-4000-8000-000000000001', 2, 'ai', 'retry', 'eeeeeeee-0000-4000-8000-0000000000a1')$$,
    (select id from created)
  ),
  '23505', null, 'a client_event_id cannot be stored twice for the same interview'
);
select throws_ok(
  format(
    $$insert into public.interview_messages (interview_id, user_id, sequence, role, content, client_event_id)
      values (%L, 'eeeeeeee-0000-4000-8000-000000000001', 1, 'user', 'other turn', gen_random_uuid())$$,
    (select id from created)
  ),
  '23505', null, 'a different turn cannot claim an existing sequence'
);
select lives_ok(
  format(
    $$insert into public.interview_messages (interview_id, user_id, sequence, role, content)
      values (%L, 'eeeeeeee-0000-4000-8000-000000000001', 2, 'system', 'server note')$$,
    (select id from created)
  ),
  'server-written messages get a generated client_event_id'
);
select isnt(
  (select client_event_id from public.interview_messages where interview_id = (select id from created) and sequence = 2),
  null,
  'the generated client_event_id is set'
);

-- Tool calls -------------------------------------------------------------------

insert into public.interview_events (interview_id, user_id, sequence, event_type, payload)
select id, user_id, 1, 'tool_call', '{"call_id": "call_1", "name": "get_file"}' from created;

select throws_ok(
  format(
    $$insert into public.interview_events (interview_id, user_id, sequence, event_type, payload)
      values (%L, 'eeeeeeee-0000-4000-8000-000000000001', 2, 'tool_call', '{"call_id": "call_1", "name": "get_file"}')$$,
    (select id from created)
  ),
  '23505', null, 'a tool call_id is executed at most once per interview'
);
select throws_ok(
  format(
    $$insert into public.interview_events (interview_id, user_id, sequence, event_type, payload)
      values (%L, 'eeeeeeee-0000-4000-8000-000000000001', 2, 'tool_call', '{"name": "get_file"}')$$,
    (select id from created)
  ),
  '23514', null, 'a tool_call event must carry a call_id'
);
select lives_ok(
  format(
    $$insert into public.interview_events (interview_id, user_id, sequence, event_type, payload)
      values (%L, 'eeeeeeee-0000-4000-8000-000000000001', 2, 'connected', '{"call_id": "call_1"}')$$,
    (select id from created)
  ),
  'call_id uniqueness applies only to tool_call events'
);
select lives_ok(
  format(
    $$insert into public.interview_events (interview_id, user_id, sequence, event_type)
      values (%L, 'eeeeeeee-0000-4000-8000-000000000001', 3, 'disconnected')$$,
    (select id from created)
  ),
  'disconnected is a valid event type'
);

reset role;

select * from finish();

rollback;
