begin;

create extension if not exists pgtap with schema extensions;

select plan(38);

-- Fixtures ------------------------------------------------------------------

insert into auth.users (id, email) values
  ('77777777-0000-4000-8000-000000000001', 'jade@example.com');

insert into public.repositories (id, user_id, github_repo_id, owner, name, full_name, is_private, default_branch) values
  ('77777777-0000-4000-8000-000000000003', '77777777-0000-4000-8000-000000000001', 7001, 'jade', 'api', 'jade/api', false, 'main');

insert into public.workspaces (id, user_id, repository_id, status, indexed_commit_sha, ready_at) values
  ('77777777-0000-4000-8000-000000000004', '77777777-0000-4000-8000-000000000001', '77777777-0000-4000-8000-000000000003', 'ready', repeat('e', 40), now());

create function pg_temp.interview_id() returns uuid language sql as $$
  select id from public.interviews where workspace_id = '77777777-0000-4000-8000-000000000004';
$$;

create function pg_temp.voice(p_client_event_id text, p_event_type text)
returns text language sql as $$
  select status || ':' || sequence
  from public.record_voice_event(
    pg_temp.interview_id(), '77777777-0000-4000-8000-000000000001', p_client_event_id::uuid,
    p_event_type::public.event_type, '{}'
  );
$$;

create function pg_temp.tool(
  p_call_id text, p_tool text, p_args jsonb, p_result jsonb default null, p_evidence jsonb default null,
  p_evaluation jsonb default null
)
returns text language sql as $$
  select status || ':' || sequence || coalesce(':' || (result ->> 'guidance'), '')
  from public.record_tool_call(
    pg_temp.interview_id(), '77777777-0000-4000-8000-000000000001', p_call_id, p_tool, p_args,
    '{"ok": true}', p_result, p_evidence, p_evaluation
  );
$$;

create function pg_temp.event_count(p_type text) returns integer language sql as $$
  select count(*)::int from public.interview_events
  where interview_id = pg_temp.interview_id() and event_type = p_type::public.event_type;
$$;

-- Privileges --------------------------------------------------------------------------

select ok(not has_function_privilege('authenticated', 'public.record_tool_call(uuid, uuid, text, text, jsonb, jsonb, jsonb, jsonb, jsonb)', 'EXECUTE'), 'authenticated cannot execute record_tool_call');
select ok(not has_function_privilege('anon', 'public.record_tool_call(uuid, uuid, text, text, jsonb, jsonb, jsonb, jsonb, jsonb)', 'EXECUTE'), 'anon cannot execute record_tool_call');
select ok(has_function_privilege('service_role', 'public.record_tool_call(uuid, uuid, text, text, jsonb, jsonb, jsonb, jsonb, jsonb)', 'EXECUTE'), 'service_role can execute record_tool_call');
select ok(not has_function_privilege('authenticated', 'public.record_evidence_examined(uuid, uuid, jsonb)', 'EXECUTE'), 'authenticated cannot execute record_evidence_examined');
select ok(has_function_privilege('service_role', 'public.record_evidence_examined(uuid, uuid, jsonb)', 'EXECUTE'), 'service_role can execute record_evidence_examined');
select ok(not has_function_privilege('authenticated', 'public.complete_interview(uuid, uuid, public.termination_reason)', 'EXECUTE'), 'authenticated cannot execute complete_interview');
select ok(not has_function_privilege('anon', 'public.complete_interview(uuid, uuid, public.termination_reason)', 'EXECUTE'), 'anon cannot execute complete_interview');
select ok(has_function_privilege('service_role', 'public.complete_interview(uuid, uuid, public.termination_reason)', 'EXECUTE'), 'service_role can execute complete_interview');
select ok(not has_function_privilege('authenticated', 'public.record_voice_event(uuid, uuid, uuid, public.event_type, jsonb)', 'EXECUTE'), 'record_voice_event stays service-role only after replacement');
select ok(
  not exists (select 1 from pg_proc where proname in ('record_tool_call', 'record_evidence_examined', 'complete_interview') and prosecdef),
  'the new functions are security invoker'
);

set local role service_role;

select lives_ok(
  $$select * from public.create_interview(
      '77777777-0000-4000-8000-000000000004', '77777777-0000-4000-8000-000000000001', repeat('e', 40), '{}', '{}', '{}')$$,
  'fixture interview is created'
);

-- Start transition --------------------------------------------------------------------

select is(public.complete_interview(pg_temp.interview_id(), '77777777-0000-4000-8000-000000000001', null), false, 'an interview that never started cannot be completed');
select is(pg_temp.voice('77777777-0000-4000-8000-0000000000c1', 'connected'), 'created:1', 'the first connected is stored at sequence 1');
select is((select status::text from public.interviews where id = pg_temp.interview_id()), 'in_progress', 'the first connected starts the interview');
select ok((select started_at is not null and last_active_at is not null from public.interviews where id = pg_temp.interview_id()), 'started_at and last_active_at are set');
select is(
  (select sequence from public.interview_events where interview_id = pg_temp.interview_id() and event_type = 'start'),
  2,
  'a start event follows the connected event'
);
select is(pg_temp.voice('77777777-0000-4000-8000-0000000000c1', 'connected'), 'duplicate:1', 'a connected retry does not start again');
select is(pg_temp.voice('77777777-0000-4000-8000-0000000000c2', 'disconnected'), 'created:3', 'disconnected takes the next sequence');
select is(pg_temp.voice('77777777-0000-4000-8000-0000000000c3', 'connected'), 'created:4', 'a reconnect is stored');
select is(pg_temp.event_count('start'), 1, 'start is emitted once');

-- Tool calls ------------------------------------------------------------------------------

select is(
  pg_temp.tool('call_1', 'get_file', '{"path": "src/a.ts"}', null, '[{"path": "src/a.ts", "area": "src", "tool": "get_file"}]'),
  'created:5',
  'a tool call gets the next event sequence'
);
select is(pg_temp.event_count('evidence_examined'), 1, 'the examined file is recorded as evidence');
select is(
  pg_temp.tool('call_1', 'get_file', '{"path": "src/a.ts"}', null, '[{"path": "src/a.ts", "area": "src", "tool": "get_file"}]'),
  'duplicate:5',
  'a retried call_id is a duplicate'
);
select is(pg_temp.event_count('evidence_examined'), 1, 'a duplicate call records no evidence');
select is(pg_temp.tool('call_1', 'get_file', '{"path": "src/b.ts"}'), 'event_conflict:5', 'the same call_id with other args conflicts');
select is(pg_temp.tool('call_1', 'search_repository', '{"path": "src/a.ts"}'), 'event_conflict:5', 'the same call_id with another tool conflicts');
select is(
  pg_temp.tool('call_2', 'search_repository', '{"query": "auth"}', null,
    '[{"path": "src/a.ts", "tool": "search_repository"}, {"path": "src/auth.ts", "area": "src", "tool": "search_repository"}]'),
  'created:7',
  'evidence events take sequences after the tool call'
);
select is(pg_temp.event_count('evidence_examined'), 2, 'evidence is deduped per interview and path');
select is(
  pg_temp.tool('call_3', 'advance_interview', '{}', '{"ok": true, "guidance": "stored"}'),
  'created:9:stored',
  'a state-changing call stores its result'
);
select is(pg_temp.tool('call_3', 'advance_interview', '{}'), 'duplicate:9:stored', 'a replay returns the stored result');
select throws_ok(
  $$select pg_temp.tool('call_4', 'drop_tables', '{}')$$,
  '22023', 'invalid_tool', 'unknown tools cannot be recorded'
);

select lives_ok(
  $$select * from public.record_transcript_turn(
      pg_temp.interview_id(), '77777777-0000-4000-8000-000000000001', '77777777-0000-4000-8000-0000000000d1',
      'ai', 'How is auth handled?', '{}')$$,
  'fixture: the interviewer asks a question'
);
create temp table eval_args as
  select jsonb_build_object(
    'message_id', (select id from public.interview_messages where client_event_id = '77777777-0000-4000-8000-0000000000d1'),
    'category', 'security', 'score', 4, 'rating', 'proficient',
    'strengths', '["JWT validation"]'::jsonb, 'gaps', '[]'::jsonb, 'repo_evidence', '["src/auth.ts"]'::jsonb,
    'discrepancy', false, 'discrepancy_detail', ''
  ) as evaluation;
select is(
  pg_temp.tool('call_5', 'evaluate_answer', '{"answerSummary": "JWTs"}', '{"ok": true, "guidance": "move_on"}', null,
    (select evaluation from eval_args)),
  'created:10:move_on',
  'evaluate_answer stores its evaluation with the tool call'
);
select is(
  pg_temp.tool('call_5', 'evaluate_answer', '{"answerSummary": "JWTs"}', '{"ok": true, "guidance": "follow_up"}', null,
    (select evaluation from eval_args)),
  'duplicate:10:move_on',
  'a replayed evaluation returns the first result'
);
select is(
  (select count(*)::int from public.evaluations where interview_id = pg_temp.interview_id() and category = 'security' and score = 4),
  1,
  'the evaluation is stored once'
);

-- Completion ---------------------------------------------------------------------------

select is(public.complete_interview(pg_temp.interview_id(), '77777777-0000-4000-8000-000000000001', null), true, 'an in-progress interview completes');
select is(public.complete_interview(pg_temp.interview_id(), '77777777-0000-4000-8000-000000000001', 'time_limit'), false, 'a second completion is a no-op');
select ok(
  (select status = 'completed' and ended_at is not null and termination_reason is null
   from public.interviews where id = pg_temp.interview_id())
  and pg_temp.event_count('completion') = 1,
  'completion sets status and ended_at and emits one completion event'
);

reset role;

select * from finish();

rollback;
