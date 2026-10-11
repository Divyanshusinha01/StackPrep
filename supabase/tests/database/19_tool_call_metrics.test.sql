begin;

create extension if not exists pgtap with schema extensions;

select plan(26);

-- Fixtures ------------------------------------------------------------------

insert into auth.users (id, email) values
  ('19191919-0000-4000-8000-000000000001', 'yan@example.com');

insert into public.repositories (id, user_id, github_repo_id, owner, name, full_name, is_private, default_branch) values
  ('19191919-0000-4000-8000-000000000003', '19191919-0000-4000-8000-000000000001', 1919, 'yan', 'api', 'yan/api', false, 'main');

insert into public.workspaces (id, user_id, repository_id, status, indexed_commit_sha, ready_at) values
  ('19191919-0000-4000-8000-000000000004', '19191919-0000-4000-8000-000000000001', '19191919-0000-4000-8000-000000000003', 'ready', repeat('f', 40), now());

select * from public.create_interview(
  '19191919-0000-4000-8000-000000000004', '19191919-0000-4000-8000-000000000001', repeat('f', 40), '{}', '{}', '{}');

create temp table ids as
select i.id as interview_id, gen_random_uuid() as connected_id
from public.interviews as i
where i.workspace_id = '19191919-0000-4000-8000-000000000004';
grant select on ids to service_role;

insert into public.interview_events (id, interview_id, user_id, sequence, event_type)
select connected_id, interview_id, '19191919-0000-4000-8000-000000000001', 1, 'connected' from ids;

create function pg_temp.metric(p_tool text, p_ms integer, p_outcome text, p_vector_ms integer, p_reason text, p_at timestamptz default now())
returns void language sql as $$
  insert into public.tool_call_metrics (interview_id, tool, duration_ms, outcome, vector_ms, vector_fallback_reason, created_at)
  select interview_id, p_tool, p_ms, p_outcome, p_vector_ms, p_reason, p_at from ids;
$$;

create function pg_temp.usage(
  p_key text, p_task text, p_source text, p_cost numeric,
  p_input bigint default 0, p_cached bigint default 0, p_audio_input bigint default 0, p_audio_cached bigint default 0
)
returns void language sql as $$
  insert into public.ai_usage (
    user_id, workspace_id, interview_id, task, model, source, input_tokens, cached_input_tokens,
    audio_input_tokens, audio_cached_input_tokens, audio_seconds, voice_segment_event_id,
    estimated_cost_usd, idempotency_key
  )
  select '19191919-0000-4000-8000-000000000001', '19191919-0000-4000-8000-000000000004', interview_id,
    p_task::public.ai_task, 'model-x', p_source::public.ai_usage_source, p_input, p_cached,
    p_audio_input, p_audio_cached,
    case when p_source = 'duration_estimate' then 60 end,
    case when p_task = 'voice' then connected_id end,
    p_cost, p_key
  from ids;
$$;

-- Privileges ----------------------------------------------------------------------

select has_table('public', 'tool_call_metrics', 'tool_call_metrics exists');
select ok(
  not has_table_privilege('authenticated', 'public.tool_call_metrics', 'SELECT')
    and not has_table_privilege('anon', 'public.tool_call_metrics', 'SELECT'),
  'clients cannot read tool_call_metrics'
);
select ok(
  has_table_privilege('service_role', 'public.tool_call_metrics', 'SELECT,INSERT')
    and not has_table_privilege('service_role', 'public.tool_call_metrics', 'UPDATE')
    and not has_table_privilege('service_role', 'public.tool_call_metrics', 'TRUNCATE'),
  'service_role can only read and insert tool_call_metrics'
);
select ok(
  not has_function_privilege('authenticated', 'public.admin_interview_cost(integer, integer)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.admin_voice_text_split(integer)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.admin_cache_hit_rate(integer)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.admin_tool_latency(integer)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.admin_tool_latency(integer)', 'EXECUTE'),
  'clients cannot execute the admin functions'
);
select ok(
  has_function_privilege('service_role', 'public.admin_interview_cost(integer, integer)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.admin_voice_text_split(integer)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.admin_cache_hit_rate(integer)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.admin_tool_latency(integer)', 'EXECUTE'),
  'service_role can execute the admin functions'
);
select ok(
  not has_function_privilege('service_role', 'public.admin_window_start(integer)', 'EXECUTE'),
  'admin_window_start is internal'
);

set local role service_role;

-- Constraints ---------------------------------------------------------------------

select throws_ok(
  $$select pg_temp.metric('get_file', 10, 'ok', 5, null)$$,
  '23514', null, 'only search_repository has vector fields'
);
select throws_ok(
  $$select pg_temp.metric('search_repository', 10, 'ok', null, 'deadline')$$,
  '23514', null, 'a fallback reason needs vector_ms'
);
select throws_ok(
  $$select pg_temp.metric('search_repository', 10, 'boom', null, null)$$,
  '23514', null, 'unknown outcomes are rejected'
);

-- Latency ---------------------------------------------------------------------------

select pg_temp.metric('search_repository', 100, 'ok', 50, null);
select pg_temp.metric('search_repository', 200, 'ok', 3000, 'deadline');
select pg_temp.metric('search_repository', 300, 'ok', 0, 'disabled');
select pg_temp.metric('search_repository', 400, 'ok', null, null);
select pg_temp.metric('get_file', 40, 'not_found', null, null);
select pg_temp.metric('get_file', 9000, 'ok', null, null, now() - interval '10 days');

select throws_ok(
  $$update public.tool_call_metrics set duration_ms = 0$$,
  '42501', null, 'metrics cannot be updated'
);

select is(
  (select array[calls, error_calls] from public.admin_tool_latency(7) where tool = 'search_repository'),
  array[4, 0],
  'search_repository calls in the window'
);
select is(
  (select array[p50_ms, p95_ms] from public.admin_tool_latency(7) where tool = 'search_repository'),
  array[250::double precision, 385::double precision],
  'duration percentiles'
);
select is(
  (select array[vector_fills, vector_fallbacks] from public.admin_tool_latency(7) where tool = 'search_repository'),
  array[2, 2],
  'a disabled fallback is a fallback but not an attempted fill'
);
select is(
  (select array[vector_p50_ms, deadline_fallback_share] from public.admin_tool_latency(7) where tool = 'search_repository'),
  array[1525::double precision, 0.5::double precision],
  'vector fill median and deadline share over attempted fills'
);
select is(
  (select array[calls, error_calls] from public.admin_tool_latency(7) where tool = 'get_file'),
  array[1, 1],
  'rows outside the window are excluded and errors are counted'
);
select ok(
  (select vector_fills = 0 and vector_p50_ms is null and deadline_fallback_share is null
   from public.admin_tool_latency(7) where tool = 'get_file'),
  'tools without a vector fill have no vector stats'
);

-- Window and limit ------------------------------------------------------------------

select throws_ok($$select * from public.admin_tool_latency(0)$$, '22023', 'invalid_window', 'a zero-day window is rejected');
select throws_ok($$select * from public.admin_cache_hit_rate(91)$$, '22023', 'invalid_window', 'windows over 90 days are rejected');
select throws_ok($$select * from public.admin_interview_cost(7, 201)$$, '22023', 'invalid_limit', 'limits over 200 are rejected');

-- Cost, split and cache hits --------------------------------------------------------
-- The client-reported voice row supersedes the duration estimate; the embedding has no price.

select pg_temp.usage('eval', 'evaluation', 'provider', 0.02, 1000, 250);
select pg_temp.usage('embed', 'embedding', 'provider', null, 500);
select pg_temp.usage('voice-est', 'voice', 'duration_estimate', 0.01);
select pg_temp.usage('voice-rt', 'voice', 'client_reported', 0.04, 100, 50, 100, 50);

select is(
  (select array[cost_usd, voice_cost_usd, text_cost_usd] from public.admin_interview_cost(7, 10)),
  array[0.06, 0.04, 0.02],
  'interview cost uses effective usage only'
);
select is(
  (select array[calls, unpriced_calls] from public.admin_interview_cost(7, 10)),
  array[3, 1],
  'unpriced calls are counted'
);
select is(
  (select has_estimate from public.admin_interview_cost(7, 10)),
  false,
  'a superseded estimate does not flag the interview'
);
select is(
  (select array_agg(channel || ':' || calls || ':' || cost_usd order by channel) from public.admin_voice_text_split(7)),
  array['text:2:0.02', 'voice:1:0.04'],
  'voice and text split'
);
select is(
  (select array_agg(channel || ':' || input_tokens || ':' || cached_input_tokens order by channel) from public.admin_cache_hit_rate(7)),
  array['text:1000:250', 'voice:200:100'],
  'cache totals leave out embeddings and count audio for voice'
);
select is(
  (select array_agg(hit_rate order by channel) from public.admin_cache_hit_rate(7)),
  array[0.25::double precision, 0.5::double precision],
  'cache hit rate per channel'
);

reset role;

select throws_ok(
  $$update public.tool_call_metrics set duration_ms = 0$$,
  '42501', 'tool_call_metrics is append-only', 'metrics cannot be updated even by the owner'
);

select * from finish();

rollback;
