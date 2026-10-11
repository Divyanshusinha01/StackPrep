-- Operational metrics for the admin dashboard: one append-only row per executed realtime tool call,
-- and narrow aggregate functions over tool_call_metrics and ai_usage_effective. Latency history
-- starts when this ships; there is no backfill.
--
-- Service role only: no client grants or policies. The dashboard reads only through the admin_*
-- functions below, which take a bounded window (and limit) and return ids and aggregates, never
-- transcripts, repository content, or emails.

-- tool_call_metrics ------------------------------------------------------------------
-- outcome is 'ok' or the tool error code of the response. vector_ms and vector_fallback_reason
-- describe the search_repository vector fill and are null when no fill ran.

create table public.tool_call_metrics (
  id uuid primary key default gen_random_uuid(),
  interview_id uuid not null references public.interviews (id) on delete cascade,
  tool text not null check (
    tool in ('search_repository', 'get_file', 'evaluate_answer', 'advance_interview', 'end_interview')
  ),
  duration_ms integer not null check (duration_ms >= 0),
  outcome text not null check (
    outcome in (
      'ok', 'invalid_arguments', 'unknown_tool', 'interview_not_active', 'not_found', 'excluded',
      'rate_limited', 'internal'
    )
  ),
  vector_ms integer check (vector_ms >= 0),
  vector_fallback_reason text check (
    vector_fallback_reason in ('deadline', 'embed_error', 'rpc_error', 'no_results', 'disabled')
  ),
  created_at timestamptz not null default now(),
  check (tool = 'search_repository' or (vector_ms is null and vector_fallback_reason is null)),
  check (vector_fallback_reason is null or vector_ms is not null)
);

create index tool_call_metrics_created_tool_idx on public.tool_call_metrics (created_at, tool);
create index tool_call_metrics_interview_idx on public.tool_call_metrics (interview_id);

-- Updates are rejected; deletes only happen through ON DELETE CASCADE.
create trigger tool_call_metrics_append_only
  before update or delete on public.tool_call_metrics
  for each row execute function public.enforce_append_only();

alter table public.tool_call_metrics enable row level security;

revoke all on public.tool_call_metrics from anon, authenticated;
-- TRUNCATE bypasses row triggers, so the service role only gets what append-only writes need.
revoke all on public.tool_call_metrics from service_role;
grant select, insert on public.tool_call_metrics to service_role;

create index ai_usage_created_idx on public.ai_usage (created_at);

-- admin_window_start -----------------------------------------------------------------
-- Every admin function takes a window in whole days, 1 to 90.

create function public.admin_window_start(p_days integer)
returns timestamptz
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_days is null or p_days not between 1 and 90 then
    raise exception using errcode = '22023', message = 'invalid_window';
  end if;
  return now() - make_interval(days => p_days);
end;
$$;

-- admin_interview_cost ----------------------------------------------------------------
-- Interviews created in the window, most expensive first, with all their effective usage.
-- cost_usd sums priced rows only; unpriced_calls counts rows whose model has no price, and
-- has_estimate marks interviews whose voice cost is still a duration estimate.

create function public.admin_interview_cost(p_days integer, p_limit integer)
returns table (
  interview_id uuid,
  interview_created_at timestamptz,
  cost_usd numeric,
  voice_cost_usd numeric,
  text_cost_usd numeric,
  calls integer,
  unpriced_calls integer,
  has_estimate boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_since timestamptz := public.admin_window_start(p_days);
begin
  if p_limit is null or p_limit not between 1 and 200 then
    raise exception using errcode = '22023', message = 'invalid_limit';
  end if;

  return query
  select
    i.id,
    i.created_at,
    coalesce(sum(u.estimated_cost_usd), 0),
    coalesce(sum(u.estimated_cost_usd) filter (where u.task = 'voice'), 0),
    coalesce(sum(u.estimated_cost_usd) filter (where u.task <> 'voice'), 0),
    count(u.id)::integer,
    (count(u.id) filter (where u.estimated_cost_usd is null))::integer,
    coalesce(bool_or(u.is_estimate), false)
  from public.interviews as i
  left join public.ai_usage_effective as u on u.interview_id = i.id
  where i.created_at >= v_since
  group by i.id, i.created_at
  order by 3 desc, i.created_at desc
  limit p_limit;
end;
$$;

-- admin_voice_text_split --------------------------------------------------------------
-- Effective usage in the window by channel: 'voice' is the realtime session and its transcription,
-- 'text' is every other AI call, including repository analysis and embeddings.

create function public.admin_voice_text_split(p_days integer)
returns table (
  channel text,
  calls integer,
  cost_usd numeric,
  estimated_cost_usd numeric,
  unpriced_calls integer,
  input_tokens bigint,
  cached_input_tokens bigint,
  output_tokens bigint,
  audio_input_tokens bigint,
  audio_cached_input_tokens bigint,
  audio_output_tokens bigint,
  audio_seconds numeric
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_since timestamptz := public.admin_window_start(p_days);
begin
  return query
  select
    c.channel,
    count(u.id)::integer,
    coalesce(sum(u.estimated_cost_usd), 0),
    coalesce(sum(u.estimated_cost_usd) filter (where u.is_estimate), 0),
    (count(u.id) filter (where u.id is not null and u.estimated_cost_usd is null))::integer,
    coalesce(sum(u.input_tokens), 0)::bigint,
    coalesce(sum(u.cached_input_tokens), 0)::bigint,
    coalesce(sum(u.output_tokens), 0)::bigint,
    coalesce(sum(u.audio_input_tokens), 0)::bigint,
    coalesce(sum(u.audio_cached_input_tokens), 0)::bigint,
    coalesce(sum(u.audio_output_tokens), 0)::bigint,
    coalesce(sum(u.audio_seconds), 0)
  from (values ('voice'), ('text')) as c (channel)
  left join public.ai_usage_effective as u
    on (case when u.task = 'voice' then 'voice' else 'text' end) = c.channel
    and u.created_at >= v_since
  group by c.channel
  order by c.channel desc;
end;
$$;

-- admin_cache_hit_rate ----------------------------------------------------------------
-- Prompt-cache hit rate in the window by channel: cached input tokens over input tokens, text and
-- audio together. Rows without token counts (duration estimates) and embeddings (never cached)
-- are left out; hit_rate is null when there is no input.

create function public.admin_cache_hit_rate(p_days integer)
returns table (
  channel text,
  calls integer,
  input_tokens bigint,
  cached_input_tokens bigint,
  hit_rate double precision
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_since timestamptz := public.admin_window_start(p_days);
begin
  return query
  with totals as (
    select
      c.channel,
      count(u.id)::integer as calls,
      coalesce(sum(u.input_tokens + u.audio_input_tokens), 0)::bigint as input_tokens,
      coalesce(sum(u.cached_input_tokens + u.audio_cached_input_tokens), 0)::bigint as cached_input_tokens
    from (values ('voice'), ('text')) as c (channel)
    left join public.ai_usage_effective as u
      on (case when u.task = 'voice' then 'voice' else 'text' end) = c.channel
      and u.created_at >= v_since
      and not u.is_estimate
      and u.task <> 'embedding'
    group by c.channel
  )
  select
    t.channel,
    t.calls,
    t.input_tokens,
    t.cached_input_tokens,
    case when t.input_tokens > 0 then t.cached_input_tokens::double precision / t.input_tokens end
  from totals as t
  order by t.channel desc;
end;
$$;

-- admin_tool_latency ------------------------------------------------------------------
-- Per tool in the window: call count, non-ok outcomes, and p50/p95 duration. For
-- search_repository also the vector fill: p50/p95 over attempted fills (a 'disabled' fallback is
-- not an attempt), fallbacks, and the share of attempted fills that hit the deadline.

create function public.admin_tool_latency(p_days integer)
returns table (
  tool text,
  calls integer,
  error_calls integer,
  p50_ms double precision,
  p95_ms double precision,
  vector_fills integer,
  vector_p50_ms double precision,
  vector_p95_ms double precision,
  vector_fallbacks integer,
  deadline_fallback_share double precision
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_since timestamptz := public.admin_window_start(p_days);
begin
  return query
  with attempts as (
    select
      m.*,
      m.vector_ms is not null and m.vector_fallback_reason is distinct from 'disabled' as attempted
    from public.tool_call_metrics as m
    where m.created_at >= v_since
  ),
  per_tool as (
    select
      a.tool,
      count(*)::integer as calls,
      (count(*) filter (where a.outcome <> 'ok'))::integer as error_calls,
      percentile_cont(0.5) within group (order by a.duration_ms) as p50_ms,
      percentile_cont(0.95) within group (order by a.duration_ms) as p95_ms,
      (count(*) filter (where a.attempted))::integer as vector_fills,
      percentile_cont(0.5) within group (order by a.vector_ms) filter (where a.attempted) as vector_p50_ms,
      percentile_cont(0.95) within group (order by a.vector_ms) filter (where a.attempted) as vector_p95_ms,
      (count(*) filter (where a.vector_fallback_reason is not null))::integer as vector_fallbacks,
      (count(*) filter (where a.attempted and a.vector_fallback_reason = 'deadline'))::integer as deadline_fallbacks
    from attempts as a
    group by a.tool
  )
  select
    p.tool,
    p.calls,
    p.error_calls,
    p.p50_ms,
    p.p95_ms,
    p.vector_fills,
    p.vector_p50_ms,
    p.vector_p95_ms,
    p.vector_fallbacks,
    case when p.vector_fills > 0 then p.deadline_fallbacks::double precision / p.vector_fills end
  from per_tool as p
  order by p.tool;
end;
$$;

-- Privileges -----------------------------------------------------------------------------

revoke execute on function public.admin_window_start(integer) from public, anon, authenticated, service_role;
revoke execute on function public.admin_interview_cost(integer, integer) from public, anon, authenticated;
revoke execute on function public.admin_voice_text_split(integer) from public, anon, authenticated;
revoke execute on function public.admin_cache_hit_rate(integer) from public, anon, authenticated;
revoke execute on function public.admin_tool_latency(integer) from public, anon, authenticated;

grant execute on function public.admin_interview_cost(integer, integer) to service_role;
grant execute on function public.admin_voice_text_split(integer) to service_role;
grant execute on function public.admin_cache_hit_rate(integer) to service_role;
grant execute on function public.admin_tool_latency(integer) to service_role;
