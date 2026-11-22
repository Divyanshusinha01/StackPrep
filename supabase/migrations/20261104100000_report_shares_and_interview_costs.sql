-- Read-only report sharing and per-interview cost reads (architecture "Report sharing" and
-- "Usage tracking").
--
-- report_shares: a bearer link to one completed interview's report. Only the SHA-256 of the token
-- is stored, so a database read cannot reveal a working link; the token is shown once, when it is
-- created. At most one share per interview is active; creating a new one revokes the old one.
-- Service role only: no client grants or policies. The owner is verified by the Edge Function
-- (through the caller's RLS client) before any of these functions run.

create table public.report_shares (
  id uuid primary key default gen_random_uuid(),
  interview_id uuid not null,
  workspace_id uuid not null,
  user_id uuid not null,
  -- Lowercase hex SHA-256 of the 43-character base64url token.
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  foreign key (interview_id, workspace_id, user_id)
    references public.interviews (id, workspace_id, user_id)
    on delete cascade
);

create unique index report_shares_one_active_idx
  on public.report_shares (interview_id)
  where revoked_at is null;
create index report_shares_interview_fk_idx
  on public.report_shares (interview_id, workspace_id, user_id);

alter table public.report_shares enable row level security;

revoke all on public.report_shares from anon, authenticated;
grant select, insert, update on public.report_shares to service_role;

-- create_report_share ---------------------------------------------------------------------
-- Returns when the share was created, or null when the interview is not the user's, is deleted or
-- not completed, or has no report yet. Any active share for the interview is revoked first.

create function public.create_report_share(
  p_interview_id uuid,
  p_user_id uuid,
  p_token_hash text
)
returns timestamptz
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_interview public.interviews;
  v_created_at timestamptz;
begin
  perform pg_advisory_xact_lock(hashtextextended('report_share:' || p_interview_id::text, 0));

  select * into v_interview
  from public.interviews as i
  where i.id = p_interview_id
    and i.user_id = p_user_id
    and i.status = 'completed'
    and i.deleted_at is null;

  if not found or not exists (
    select 1
    from public.reports as r
    where r.interview_id = p_interview_id
      and r.user_id = p_user_id
  ) then
    return null;
  end if;

  update public.report_shares
  set revoked_at = now()
  where interview_id = p_interview_id
    and revoked_at is null;

  insert into public.report_shares (interview_id, workspace_id, user_id, token_hash)
  values (p_interview_id, v_interview.workspace_id, p_user_id, p_token_hash)
  returning created_at into v_created_at;

  return v_created_at;
end;
$$;

-- revoke_report_share ---------------------------------------------------------------------
-- True when an active share was revoked; false when there was none.

create function public.revoke_report_share(p_interview_id uuid, p_user_id uuid)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.report_shares
  set revoked_at = now()
  where interview_id = p_interview_id
    and user_id = p_user_id
    and revoked_at is null;
  get diagnostics v_count = row_count;
  return v_count > 0;
end;
$$;

-- get_report_share ------------------------------------------------------------------------
-- When the active share was created, or null. Never returns the token or its hash.

create function public.get_report_share(p_interview_id uuid, p_user_id uuid)
returns timestamptz
language sql
stable
security invoker
set search_path = ''
as $$
  select s.created_at
  from public.report_shares as s
  where s.interview_id = p_interview_id
    and s.user_id = p_user_id
    and s.revoked_at is null;
$$;

-- resolve_report_share --------------------------------------------------------------------
-- The one read behind the public link. Returns the report only while the share is active and its
-- interview is not deleted. Exposes no user, workspace or interview ids, and no transcript.

create function public.resolve_report_share(p_token_hash text)
returns table (
  interview_number integer,
  repository_full_name text,
  is_private boolean,
  generated_at timestamptz,
  content jsonb
)
language sql
stable
security invoker
set search_path = ''
as $$
  select i.interview_number, rp.full_name, rp.is_private, r.generated_at, r.content
  from public.report_shares as s
  join public.interviews as i
    on i.id = s.interview_id and i.workspace_id = s.workspace_id and i.user_id = s.user_id
  join public.reports as r
    on r.interview_id = i.id
  join public.workspaces as w
    on w.id = i.workspace_id and w.user_id = i.user_id
  join public.repositories as rp
    on rp.id = w.repository_id and rp.user_id = w.user_id
  where s.token_hash = p_token_hash
    and s.revoked_at is null
    and i.deleted_at is null
    and i.status = 'completed';
$$;

revoke execute on function
  public.create_report_share(uuid, uuid, text),
  public.revoke_report_share(uuid, uuid),
  public.get_report_share(uuid, uuid),
  public.resolve_report_share(text)
from public, anon, authenticated;
grant execute on function
  public.create_report_share(uuid, uuid, text),
  public.revoke_report_share(uuid, uuid),
  public.get_report_share(uuid, uuid),
  public.resolve_report_share(text)
to service_role;

-- workspace_interview_costs ---------------------------------------------------------------
-- Estimated AI spend per (non-deleted) interview of a workspace, from ai_usage_effective, so
-- reconciled voice usage is counted once. Repository analysis rows have no interview and are not
-- included. Cost is an estimate from the price table; rows whose model has no price count as
-- `unpriced_calls` rather than as zero.

create function public.workspace_interview_costs(p_workspace_id uuid, p_user_id uuid)
returns table (
  interview_id uuid,
  interview_number integer,
  cost_usd numeric,
  voice_cost_usd numeric,
  text_cost_usd numeric,
  has_estimate boolean,
  unpriced_calls bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    i.id,
    i.interview_number,
    coalesce(sum(u.estimated_cost_usd), 0),
    coalesce(sum(u.estimated_cost_usd) filter (where u.task = 'voice'), 0),
    coalesce(sum(u.estimated_cost_usd) filter (where u.task <> 'voice'), 0),
    coalesce(bool_or(u.is_estimate), false),
    count(u.id) filter (where u.estimated_cost_usd is null)
  from public.interviews as i
  left join public.ai_usage_effective as u
    on u.interview_id = i.id and u.workspace_id = i.workspace_id and u.user_id = i.user_id
  where i.workspace_id = p_workspace_id
    and i.user_id = p_user_id
    and i.deleted_at is null
  group by i.id, i.interview_number
  order by i.interview_number desc;
$$;

revoke execute on function public.workspace_interview_costs(uuid, uuid) from public, anon, authenticated;
grant execute on function public.workspace_interview_costs(uuid, uuid) to service_role;
