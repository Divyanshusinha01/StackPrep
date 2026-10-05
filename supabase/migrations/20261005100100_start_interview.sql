-- POST /workspaces/:id/interviews: create the interview, its empty state, and the planning job
-- in one transaction (architecture section 5, Phase 1).

-- jobs ----------------------------------------------------------------------

alter table public.jobs
  drop constraint jobs_stage_check,
  add constraint jobs_stage_check
    check (stage is null or stage in ('scanning', 'analyzing', 'preparing_context', 'planning')),
  add constraint jobs_interview_planning_has_interview
    check (type <> 'interview_planning' or interview_id is not null);

-- At most one queued/running planning run per interview.
create unique index jobs_active_interview_planning_key
  on public.jobs (interview_id)
  where type = 'interview_planning' and status in ('queued', 'running');

create index interviews_user_id_created_at_idx on public.interviews (user_id, created_at);

-- start_interview -----------------------------------------------------------
-- Errors (message is the code):
--   P0002 workspace_not_found      missing or not the user's
--   55000 workspace_not_ready      not ready, or its indexed commit is not p_commit_sha
--   P0429 interview_limit_reached  5 interviews in the last 24 hours across all workspaces;
--                                  detail is the ISO 8601 time the next one is allowed

create function public.start_interview(
  p_workspace_id uuid,
  p_user_id uuid,
  p_commit_sha text
)
returns table (
  interview_id uuid,
  interview_number integer,
  status public.interview_status,
  created_at timestamptz,
  job_id uuid
)
language plpgsql
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_limit constant integer := 5;
  v_window constant interval := interval '24 hours';
  v_workspace public.workspaces;
  v_count integer;
  v_next_at timestamptz;
  v_interview public.interviews;
  v_job_id uuid;
begin
  -- Serializes the rate-limit check per user, across workspaces.
  perform pg_advisory_xact_lock(hashtext('start_interview'), hashtext(p_user_id::text));

  select * into v_workspace
  from public.workspaces as w
  where w.id = p_workspace_id
  for update;

  if not found or v_workspace.user_id is distinct from p_user_id then
    raise exception using errcode = 'P0002', message = 'workspace_not_found';
  end if;

  if v_workspace.status <> 'ready'
     or v_workspace.indexed_commit_sha is null
     or v_workspace.indexed_commit_sha is distinct from p_commit_sha then
    raise exception using errcode = '55000', message = 'workspace_not_ready';
  end if;

  select count(*) into v_count
  from public.interviews as i
  where i.user_id = p_user_id
    and i.created_at > now() - v_window;

  if v_count >= v_limit then
    -- The window drops below the limit once the oldest (v_count - v_limit + 1) interviews age out.
    select i.created_at + v_window into v_next_at
    from public.interviews as i
    where i.user_id = p_user_id
      and i.created_at > now() - v_window
    order by i.created_at
    offset (v_count - v_limit)
    limit 1;

    raise exception using
      errcode = 'P0429',
      message = 'interview_limit_reached',
      detail = to_jsonb(v_next_at) #>> '{}';
  end if;

  select * into v_interview
  from public.create_interview(p_workspace_id, p_user_id, p_commit_sha, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb);

  insert into public.jobs (user_id, workspace_id, interview_id, type, status, repository_commit_sha)
  values (p_user_id, p_workspace_id, v_interview.id, 'interview_planning', 'queued', p_commit_sha)
  returning id into v_job_id;

  return query select v_interview.id, v_interview.interview_number, v_interview.status, v_interview.created_at, v_job_id;
end;
$$;

revoke execute on function public.start_interview(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.start_interview(uuid, uuid, text) to service_role;
