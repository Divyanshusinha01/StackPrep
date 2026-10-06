begin;

create extension if not exists pgtap with schema extensions;

select plan(17);

-- Fixtures ------------------------------------------------------------------

insert into auth.users (id, email) values
  ('aa000000-0000-4000-8000-000000000001', 'uma@example.com');

insert into public.repositories (id, user_id, github_repo_id, owner, name, full_name, is_private, default_branch) values
  ('aa000000-0000-4000-8000-000000000003', 'aa000000-0000-4000-8000-000000000001', 10001, 'uma', 'api', 'uma/api', false, 'main');

insert into public.workspaces (id, user_id, repository_id, status, indexed_commit_sha, ready_at) values
  ('aa000000-0000-4000-8000-000000000004', 'aa000000-0000-4000-8000-000000000001', 'aa000000-0000-4000-8000-000000000003', 'ready', repeat('f', 40), now());

-- Schema and privileges -------------------------------------------------------------

select has_table('public', 'ai_usage', 'ai_usage exists');
select has_view('public', 'ai_usage_effective', 'ai_usage_effective exists');
select ok(
  not has_table_privilege('authenticated', 'public.ai_usage', 'SELECT') and not has_table_privilege('anon', 'public.ai_usage', 'SELECT'),
  'clients cannot read ai_usage'
);
select ok(
  not has_table_privilege('authenticated', 'public.ai_usage_effective', 'SELECT'),
  'clients cannot read ai_usage_effective'
);
select ok(
  has_table_privilege('service_role', 'public.ai_usage', 'SELECT,INSERT')
    and not has_table_privilege('service_role', 'public.ai_usage', 'UPDATE')
    and not has_table_privilege('service_role', 'public.ai_usage', 'TRUNCATE'),
  'service_role can only read and insert ai_usage'
);

set local role service_role;

select lives_ok(
  $$select * from public.create_interview(
      'aa000000-0000-4000-8000-000000000004', 'aa000000-0000-4000-8000-000000000001', repeat('f', 40), '{}', '{}', '{}')$$,
  'fixture interview is created'
);

create temp table ids as
select
  i.id as interview_id,
  gen_random_uuid() as connected_id,
  gen_random_uuid() as start_id
from public.interviews as i
where i.workspace_id = 'aa000000-0000-4000-8000-000000000004';

insert into public.interview_events (id, interview_id, user_id, sequence, event_type)
select connected_id, interview_id, 'aa000000-0000-4000-8000-000000000001', 1, 'connected' from ids
union all
select start_id, interview_id, 'aa000000-0000-4000-8000-000000000001', 2, 'start' from ids;

create function pg_temp.usage(p_key text, p_task text, p_model text, p_source text, p_segment uuid)
returns void language sql as $$
  insert into public.ai_usage (
    user_id, workspace_id, interview_id, task, model, source, audio_seconds, voice_segment_event_id,
    estimated_cost_usd, idempotency_key
  )
  select 'aa000000-0000-4000-8000-000000000001', 'aa000000-0000-4000-8000-000000000004', interview_id,
    p_task::public.ai_task, p_model, p_source::public.ai_usage_source,
    case when p_source = 'duration_estimate' then 60 end, p_segment, 0.01, p_key
  from ids;
$$;

-- Constraints ------------------------------------------------------------------------

select lives_ok(
  $$select pg_temp.usage('eval-1', 'evaluation', 'gpt-5.6-terra', 'provider', null)$$,
  'a provider row for a text task is stored'
);
select throws_ok(
  $$select pg_temp.usage('voice-bad', 'voice', 'gpt-realtime-2.1-mini', 'client_reported', null)$$,
  '23514', null, 'voice rows require a voice segment'
);
select throws_ok(
  $$select pg_temp.usage('voice-start', 'voice', 'gpt-realtime-2.1-mini', 'client_reported', (select start_id from ids))$$,
  '23514', 'invalid_voice_segment', 'a voice segment must be a connected event'
);
select throws_ok(
  $$select pg_temp.usage('eval-client', 'evaluation', 'gpt-5.6-terra', 'client_reported', null)$$,
  '23514', null, 'non-voice rows are provider rows'
);

-- Reconciliation ---------------------------------------------------------------------

select pg_temp.usage('est-rt', 'voice', 'gpt-realtime-2.1-mini', 'duration_estimate', (select connected_id from ids));
select pg_temp.usage('est-tx', 'voice', 'gpt-4o-mini-transcribe', 'duration_estimate', (select connected_id from ids));

select is(
  (select array_agg(model || ':' || source || ':' || is_estimate order by model) from public.ai_usage_effective where task = 'voice'),
  array['gpt-4o-mini-transcribe:duration_estimate:true', 'gpt-realtime-2.1-mini:duration_estimate:true'],
  'without relayed usage both estimates are effective'
);

select pg_temp.usage('client-1', 'voice', 'gpt-realtime-2.1-mini', 'client_reported', (select connected_id from ids));
select pg_temp.usage('client-2', 'voice', 'gpt-realtime-2.1-mini', 'client_reported', (select connected_id from ids));

select is(
  (select array_agg(e.model || ':' || e.source order by e.model, u.idempotency_key) from public.ai_usage_effective as e
   join public.ai_usage as u on u.id = e.id where e.task = 'voice'),
  array['gpt-4o-mini-transcribe:duration_estimate', 'gpt-realtime-2.1-mini:client_reported', 'gpt-realtime-2.1-mini:client_reported'],
  'relayed usage supersedes the realtime estimate; the transcription estimate stands'
);
select is(
  (select count(*)::int from public.ai_usage_effective where task = 'evaluation'),
  1,
  'non-voice rows pass through'
);
select is((select count(*)::int from public.ai_usage), 5, 'raw rows are all kept');

-- Idempotency and append-only --------------------------------------------------------

select lives_ok(
  $$insert into public.ai_usage (user_id, workspace_id, task, model, source, idempotency_key)
    values ('aa000000-0000-4000-8000-000000000001', 'aa000000-0000-4000-8000-000000000004', 'deep_analysis', 'gpt-5.6-terra', 'provider', 'eval-1')
    on conflict (idempotency_key) do nothing$$,
  'a repeated idempotency key is a no-op'
);
select throws_ok(
  $$update public.ai_usage set estimated_cost_usd = 0 where idempotency_key = 'eval-1'$$,
  '42501', null, 'rows cannot be updated'
);

reset role;

select throws_ok(
  $$update public.ai_usage set estimated_cost_usd = 0 where idempotency_key = 'eval-1'$$,
  '42501', 'ai_usage is append-only', 'rows cannot be updated even by the owner'
);

select * from finish();

rollback;
