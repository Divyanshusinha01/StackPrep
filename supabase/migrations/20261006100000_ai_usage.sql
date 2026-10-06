-- AI usage tracking (architecture "Usage tracking"). One append-only row per AI call; cost is an
-- estimate from the price table in @stackprep/shared, and raw token counts are kept so it can be
-- recalculated.
--
-- source:
--   provider            counts returned by the provider to the backend; authoritative
--   client_reported     counts relayed by the browser (Realtime `response.done`); provisional
--   duration_estimate   derived from connected voice time; an approximation, never actual spend
--
-- Voice rows belong to a voice segment, identified by the `connected` interview event that opened
-- it. ai_usage_effective picks, per segment and model, the most authoritative source present.
-- Service role only: no client grants or policies.

create type public.ai_task as enum (
  'voice',
  'auxiliary',
  'deep_analysis',
  'planning',
  'evaluation',
  'report',
  'vision'
);

create type public.ai_usage_source as enum ('provider', 'client_reported', 'duration_estimate');

alter table public.interview_events
  add constraint interview_events_id_interview_id_key unique (id, interview_id);

-- ai_usage ---------------------------------------------------------------------
-- Input counts include their cached portion, as in the provider's `usage`.

create table public.ai_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  workspace_id uuid not null,
  -- Null for repository analysis.
  interview_id uuid,
  task public.ai_task not null,
  model text not null check (char_length(model) between 1 and 100),
  source public.ai_usage_source not null,
  input_tokens bigint not null default 0 check (input_tokens >= 0),
  cached_input_tokens bigint not null default 0 check (cached_input_tokens >= 0),
  output_tokens bigint not null default 0 check (output_tokens >= 0),
  audio_input_tokens bigint not null default 0 check (audio_input_tokens >= 0),
  audio_cached_input_tokens bigint not null default 0 check (audio_cached_input_tokens >= 0),
  audio_output_tokens bigint not null default 0 check (audio_output_tokens >= 0),
  audio_seconds numeric check (audio_seconds >= 0),
  -- The `connected` event that opened the voice segment this row belongs to.
  voice_segment_event_id uuid,
  -- Null when the model has no price.
  estimated_cost_usd numeric check (estimated_cost_usd >= 0),
  idempotency_key text unique check (char_length(idempotency_key) between 1 and 200),
  created_at timestamptz not null default now(),
  foreign key (workspace_id, user_id)
    references public.workspaces (id, user_id)
    on delete cascade,
  foreign key (interview_id, workspace_id, user_id)
    references public.interviews (id, workspace_id, user_id)
    on delete cascade,
  foreign key (voice_segment_event_id, interview_id)
    references public.interview_events (id, interview_id)
    on delete cascade,
  check (cached_input_tokens <= input_tokens),
  check (audio_cached_input_tokens <= audio_input_tokens),
  -- Voice usage never reaches the backend from the provider today; everything else does.
  check ((task = 'voice') = (source <> 'provider')),
  check (task <> 'voice' or (voice_segment_event_id is not null and interview_id is not null)),
  check (voice_segment_event_id is null or task = 'voice'),
  check (source <> 'duration_estimate' or audio_seconds is not null)
);

create index ai_usage_user_created_idx on public.ai_usage (user_id, created_at);
create index ai_usage_workspace_user_idx on public.ai_usage (workspace_id, user_id);
create index ai_usage_interview_idx on public.ai_usage (interview_id, workspace_id, user_id)
  where interview_id is not null;
create index ai_usage_voice_segment_idx on public.ai_usage (voice_segment_event_id, source)
  where voice_segment_event_id is not null;

-- A voice segment is always opened by a `connected` event.
create function public.assert_ai_usage_voice_segment()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.voice_segment_event_id is not null and not exists (
    select 1 from public.interview_events as e
    where e.id = new.voice_segment_event_id
      and e.interview_id = new.interview_id
      and e.event_type = 'connected'
  ) then
    raise exception using errcode = '23514', message = 'invalid_voice_segment';
  end if;
  return new;
end;
$$;

create trigger ai_usage_voice_segment
  before insert on public.ai_usage
  for each row execute function public.assert_ai_usage_voice_segment();

-- Updates are rejected; deletes only happen through ON DELETE CASCADE.
create trigger ai_usage_append_only
  before update or delete on public.ai_usage
  for each row execute function public.enforce_append_only();

revoke execute on function public.assert_ai_usage_voice_segment() from public, anon, authenticated;

alter table public.ai_usage enable row level security;

revoke all on public.ai_usage from anon, authenticated;
-- TRUNCATE bypasses row triggers, so the service role only gets what append-only writes need.
revoke all on public.ai_usage from service_role;
grant select, insert on public.ai_usage to service_role;

-- ai_usage_effective -----------------------------------------------------------
-- Reconciled view for cost reporting; raw rows are never changed.
--   Non-voice rows pass through.
--   Voice rows, per (voice_segment_event_id, model): provider rows if any exist, else
--   client_reported rows if any exist, else the duration_estimate row (is_estimate = true).
-- For the realtime model this means relayed usage supersedes the estimate; for transcription the
-- estimate stands until provider usage exists.

create view public.ai_usage_effective
with (security_invoker = true)
as
with voice_sources as (
  select
    u.voice_segment_event_id,
    u.model,
    bool_or(u.source = 'provider') as has_provider,
    bool_or(u.source = 'client_reported') as has_client_reported
  from public.ai_usage as u
  where u.task = 'voice'
  group by u.voice_segment_event_id, u.model
)
select
  u.id,
  u.user_id,
  u.workspace_id,
  u.interview_id,
  u.task,
  u.model,
  u.source,
  u.input_tokens,
  u.cached_input_tokens,
  u.output_tokens,
  u.audio_input_tokens,
  u.audio_cached_input_tokens,
  u.audio_output_tokens,
  u.audio_seconds,
  u.voice_segment_event_id,
  u.estimated_cost_usd,
  u.source = 'duration_estimate' as is_estimate,
  u.created_at
from public.ai_usage as u
left join voice_sources as v
  on v.voice_segment_event_id = u.voice_segment_event_id
  and v.model = u.model
where u.task <> 'voice'
  or u.source = case
    when v.has_provider then 'provider'::public.ai_usage_source
    when v.has_client_reported then 'client_reported'::public.ai_usage_source
    else 'duration_estimate'::public.ai_usage_source
  end;

revoke all on public.ai_usage_effective from anon, authenticated;
grant select on public.ai_usage_effective to service_role;
