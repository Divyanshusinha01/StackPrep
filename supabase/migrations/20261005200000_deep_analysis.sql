-- Deep repository analysis (Inngest `repository.deep_analysis.requested`, architecture section 6).
-- Chained best-effort after a baseline repository analysis. AI output is stored under
-- `structured.ai` on the baseline memory rows of the analyzed commit plus one `concepts` row; it
-- never affects workspace readiness.

-- jobs ----------------------------------------------------------------------

alter table public.jobs
  drop constraint jobs_stage_check,
  add constraint jobs_stage_check
    check (stage is null or stage in (
      'scanning', 'analyzing', 'preparing_context', 'planning', 'reporting', 'deep_analysis'
    ));

-- At most one queued/running deep analysis per workspace. This index is the final concurrency
-- guard: request_deep_analysis inserts with `on conflict do nothing` instead of checking first.
create unique index jobs_active_deep_analysis_key
  on public.jobs (workspace_id)
  where type = 'deep_analysis' and status in ('queued', 'running');

-- request_deep_analysis ---------------------------------------------------------
-- Queues a deep_analysis job for one analyzed commit. Returns the new job id, or null when the
-- commit has no baseline architecture_summary row, that row already carries the
-- `metadata.deep_analysis` marker, or a deep analysis is already active for the workspace.
-- Only the given commit's row is checked, so an analyzed older commit never suppresses a new one.
--
-- Manual concurrency check: run `select public.request_deep_analysis(w, sha)` from two sessions
-- at once; exactly one returns an id and the other returns null without raising.

create function public.request_deep_analysis(
  p_workspace_id uuid,
  p_commit_sha text
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_workspace public.workspaces;
  v_metadata jsonb;
  v_job_id uuid;
begin
  select * into v_workspace
  from public.workspaces as w
  where w.id = p_workspace_id
  for update;

  if not found then
    return null;
  end if;

  select m.metadata into v_metadata
  from public.repository_memory as m
  where m.workspace_id = p_workspace_id
    and m.repository_commit_sha = p_commit_sha
    and m.kind = 'architecture_summary';

  if not found or v_metadata ? 'deep_analysis' then
    return null;
  end if;

  insert into public.jobs (user_id, workspace_id, type, status, repository_commit_sha)
  values (v_workspace.user_id, p_workspace_id, 'deep_analysis', 'queued', p_commit_sha)
  on conflict (workspace_id) where type = 'deep_analysis' and status in ('queued', 'running') do nothing
  returning id into v_job_id;

  return v_job_id;
end;
$$;

-- save_deep_analysis ------------------------------------------------------------
-- p_payload: {
--   model: text, analyzer_version: int,
--   architecture_summary: object,   -- becomes structured.ai on the architecture_summary row
--   modules: object,                -- becomes structured.ai on the modules row
--   concepts: { content: text, ai: object }  -- the commit's concepts row
-- }
-- `structured.ai` is replaced, never merged, so a retried step is idempotent and cannot
-- reintroduce duplicates. The job is marked succeeded in the same transaction.
-- Errors (message is the code):
--   22023 invalid_deep_analysis_payload  payload is not the shape above
--   P0002 deep_analysis_job_not_found    no deep_analysis job with this id for this workspace and commit
--   P0002 repository_memory_not_found    the commit has no baseline architecture_summary row

create function public.save_deep_analysis(
  p_workspace_id uuid,
  p_job_id uuid,
  p_commit_sha text,
  p_payload jsonb
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_workspace public.workspaces;
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object'
    or jsonb_typeof(p_payload -> 'model') is distinct from 'string'
    or jsonb_typeof(p_payload -> 'architecture_summary') is distinct from 'object'
    or jsonb_typeof(p_payload -> 'modules') is distinct from 'object'
    or jsonb_typeof(p_payload -> 'concepts') is distinct from 'object'
    or jsonb_typeof(p_payload -> 'concepts' -> 'content') is distinct from 'string'
    or jsonb_typeof(p_payload -> 'concepts' -> 'ai') is distinct from 'object'
  then
    raise exception using errcode = '22023', message = 'invalid_deep_analysis_payload';
  end if;

  select w.* into v_workspace
  from public.jobs as j
  join public.workspaces as w on w.id = j.workspace_id and w.user_id = j.user_id
  where j.id = p_job_id
    and j.workspace_id = p_workspace_id
    and j.type = 'deep_analysis'
    and j.repository_commit_sha = p_commit_sha;

  if not found then
    raise exception using errcode = 'P0002', message = 'deep_analysis_job_not_found';
  end if;

  update public.repository_memory as m
  set structured = m.structured || jsonb_build_object('ai', p_payload -> 'architecture_summary'),
      metadata = m.metadata || jsonb_build_object('deep_analysis', jsonb_build_object(
        'model', p_payload -> 'model',
        'analyzer_version', p_payload -> 'analyzer_version',
        'generated_at', now()
      ))
  where m.workspace_id = p_workspace_id
    and m.repository_commit_sha = p_commit_sha
    and m.kind = 'architecture_summary';

  if not found then
    raise exception using errcode = 'P0002', message = 'repository_memory_not_found';
  end if;

  update public.repository_memory as m
  set structured = m.structured || jsonb_build_object('ai', p_payload -> 'modules')
  where m.workspace_id = p_workspace_id
    and m.repository_commit_sha = p_commit_sha
    and m.kind = 'modules';

  insert into public.repository_memory
    (workspace_id, repository_id, user_id, repository_commit_sha, kind, content, structured, metadata)
  values (
    v_workspace.id,
    v_workspace.repository_id,
    v_workspace.user_id,
    p_commit_sha,
    'concepts',
    p_payload -> 'concepts' ->> 'content',
    jsonb_build_object('ai', p_payload -> 'concepts' -> 'ai'),
    jsonb_build_object(
      'source', 'deep_analysis',
      'analyzer_version', p_payload -> 'analyzer_version',
      'commit_sha', p_commit_sha
    )
  )
  on conflict (workspace_id, repository_commit_sha, kind) where kind <> 'file_summary' do update
  set content = excluded.content,
      structured = public.repository_memory.structured || jsonb_build_object('ai', excluded.structured -> 'ai'),
      metadata = public.repository_memory.metadata || excluded.metadata;

  update public.jobs
  set status = 'succeeded',
      progress = 100,
      stage = null,
      error_code = null,
      error_message = null,
      started_at = coalesce(started_at, now()),
      finished_at = now()
  where id = p_job_id;
end;
$$;

-- fail_deep_analysis ------------------------------------------------------------
-- Marks only the job failed; a succeeded job is never downgraded and the workspace status is
-- never touched, since deep analysis never decides readiness.

create function public.fail_deep_analysis(
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
  update public.jobs
  set status = 'failed',
      error_code = p_error_code,
      error_message = p_error_message,
      finished_at = now()
  where id = p_job_id
    and workspace_id = p_workspace_id
    and type = 'deep_analysis'
    and status <> 'succeeded';
end;
$$;

revoke execute on function public.request_deep_analysis(uuid, text) from public, anon, authenticated;
grant execute on function public.request_deep_analysis(uuid, text) to service_role;

revoke execute on function public.save_deep_analysis(uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.save_deep_analysis(uuid, uuid, text, jsonb) to service_role;

revoke execute on function public.fail_deep_analysis(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.fail_deep_analysis(uuid, uuid, text, text) to service_role;
