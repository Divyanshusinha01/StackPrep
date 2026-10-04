-- Lightweight repository analysis (Inngest `repository.analysis.requested`).
-- jobs stays the UI read-model of the Inngest run; these functions are the only way a run
-- finishes, so completion and failure are atomic and safe to repeat on Inngest retries.

-- repository_memory ---------------------------------------------------------
-- One row per summary kind per analyzed commit. file_summary rows are per-file and excluded.

create unique index repository_memory_workspace_commit_kind_key
  on public.repository_memory (workspace_id, repository_commit_sha, kind)
  where kind <> 'file_summary';

-- jobs ----------------------------------------------------------------------

alter table public.jobs
  add column repository_commit_sha public.git_commit_sha,
  add column error_code text check (error_code is null or error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  add constraint jobs_stage_check
    check (stage is null or stage in ('scanning', 'analyzing', 'preparing_context'));

-- At most one queued/running analysis per workspace (guards double-submitted retries).
create unique index jobs_active_repository_indexing_key
  on public.jobs (workspace_id)
  where type = 'repository_indexing' and status in ('queued', 'running');

-- complete_repository_analysis ------------------------------------------------
-- p_memory: jsonb array of {kind, content, structured?, metadata?, token_count?}.
-- Existing memory for the commit is never overwritten. The workspace only becomes ready when
-- the analyzed commit is still its target. Returns true when the workspace is ready.

create function public.complete_repository_analysis(
  p_workspace_id uuid,
  p_job_id uuid,
  p_commit_sha text,
  p_memory jsonb
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_workspace public.workspaces;
begin
  if jsonb_typeof(p_memory) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'memory_must_be_array';
  end if;

  select * into v_workspace
  from public.workspaces as w
  where w.id = p_workspace_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'workspace_not_found';
  end if;

  if not exists (
    select 1 from public.jobs as j
    where j.id = p_job_id and j.workspace_id = p_workspace_id and j.type = 'repository_indexing'
  ) then
    raise exception using errcode = 'P0002', message = 'job_not_found';
  end if;

  insert into public.repository_memory
    (workspace_id, repository_id, user_id, repository_commit_sha, kind, content, structured, metadata, token_count)
  select
    v_workspace.id,
    v_workspace.repository_id,
    v_workspace.user_id,
    p_commit_sha,
    m.kind,
    m.content,
    coalesce(m.structured, '{}'::jsonb),
    coalesce(m.metadata, '{}'::jsonb),
    m.token_count
  from jsonb_to_recordset(p_memory) as m(
    kind text, content text, structured jsonb, metadata jsonb, token_count integer
  )
  on conflict (workspace_id, repository_commit_sha, kind) where kind <> 'file_summary' do nothing;

  if v_workspace.target_commit_sha is not distinct from p_commit_sha then
    update public.workspaces
    set status = 'ready',
        indexed_commit_sha = p_commit_sha,
        ready_at = case
          when status = 'ready' and indexed_commit_sha = p_commit_sha then ready_at
          else now()
        end
    where id = p_workspace_id;
  end if;

  update public.jobs
  set status = 'succeeded',
      progress = 100,
      stage = null,
      repository_commit_sha = coalesce(repository_commit_sha, p_commit_sha),
      error_code = null,
      error_message = null,
      started_at = coalesce(started_at, now()),
      finished_at = coalesce(finished_at, now())
  where id = p_job_id;

  return v_workspace.target_commit_sha is not distinct from p_commit_sha;
end;
$$;

-- fail_repository_analysis ----------------------------------------------------
-- A succeeded job is never downgraded. The workspace only moves analyzing -> failed, and not
-- while another analysis for it is still active.

create function public.fail_repository_analysis(
  p_workspace_id uuid,
  p_job_id uuid,
  p_error_code text,
  p_error_message text
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  perform 1 from public.workspaces as w where w.id = p_workspace_id for update;

  update public.jobs
  set status = 'failed',
      error_code = p_error_code,
      error_message = p_error_message,
      finished_at = now()
  where id = p_job_id
    and workspace_id = p_workspace_id
    and type = 'repository_indexing'
    and status <> 'succeeded';

  if not found then
    return;
  end if;

  update public.workspaces as w
  set status = 'failed'
  where w.id = p_workspace_id
    and w.status = 'analyzing'
    and not exists (
      select 1 from public.jobs as j
      where j.workspace_id = p_workspace_id
        and j.type = 'repository_indexing'
        and j.status in ('queued', 'running')
    );
end;
$$;

-- retry_repository_analysis ---------------------------------------------------
-- Atomically moves a failed workspace back to analyzing and queues a new job for its target
-- commit. Returns null when the workspace is not the user's, not failed, or already retrying.

create function public.retry_repository_analysis(p_workspace_id uuid, p_user_id uuid)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_workspace public.workspaces;
  v_job_id uuid;
begin
  select * into v_workspace
  from public.workspaces as w
  where w.id = p_workspace_id and w.user_id = p_user_id
  for update;

  if not found or v_workspace.status <> 'failed' or v_workspace.target_commit_sha is null then
    return null;
  end if;

  update public.workspaces set status = 'analyzing' where id = p_workspace_id;

  insert into public.jobs (user_id, workspace_id, type, status, repository_commit_sha)
  values (p_user_id, p_workspace_id, 'repository_indexing', 'queued', v_workspace.target_commit_sha)
  on conflict (workspace_id) where type = 'repository_indexing' and status in ('queued', 'running')
  do nothing
  returning id into v_job_id;

  if v_job_id is null then
    raise exception using errcode = '23505', message = 'analysis_already_active';
  end if;

  return v_job_id;
end;
$$;

revoke execute on function public.complete_repository_analysis(uuid, uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.complete_repository_analysis(uuid, uuid, text, jsonb) to service_role;

revoke execute on function public.fail_repository_analysis(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.fail_repository_analysis(uuid, uuid, text, text) to service_role;

revoke execute on function public.retry_repository_analysis(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.retry_repository_analysis(uuid, uuid) to service_role;
