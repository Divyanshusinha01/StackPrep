-- Push sync (GitHub `push` webhook -> Inngest `repository.push.received`, architecture section 6).
-- A ready workspace follows its repository's default branch. The webhook bumps push_generation
-- before it enqueues anything, so a push is durably pending while push_generation >
-- synced_generation, whatever happens to the events afterwards. follow_repository_head advances
-- synced_generation (never past what the sync observed) and moves target_commit_sha; only
-- complete_repository_analysis ever moves indexed_commit_sha, so interviews keep the last
-- analyzed commit until the new one is analyzed.

-- workspaces ----------------------------------------------------------------

alter table public.workspaces
  add column push_generation bigint not null default 0 check (push_generation >= 0),
  add column synced_generation bigint not null default 0 check (synced_generation >= 0),
  add constraint workspaces_generation_order_check check (synced_generation <= push_generation);

-- mark_push_received ------------------------------------------------------------
-- Marks a push for every ready workspace of the repository reachable through a non-suspended
-- connection with this installation (several users can share one repository). Returns their ids.

create function public.mark_push_received(
  p_github_repo_id bigint,
  p_installation_id bigint
)
returns setof uuid
language sql
security invoker
set search_path = ''
as $$
  update public.workspaces as w
  set push_generation = w.push_generation + 1
  from public.repositories as r
  join public.github_connections as c on c.id = r.github_connection_id and c.user_id = r.user_id
  where w.repository_id = r.id
    and w.user_id = r.user_id
    and w.status = 'ready'
    and r.github_repo_id = p_github_repo_id
    and c.installation_id = p_installation_id
    and c.suspended_at is null
  returning w.id;
$$;

-- follow_repository_head ------------------------------------------------------------
-- Moves a ready workspace to the branch head a push sync resolved after reading
-- p_observed_generation. Outcomes:
--   not_ready        the workspace is missing or not ready; nothing changes
--   analysis_active  a baseline, deep analysis or code index is queued or running; nothing changes
--   up_to_date       the head is the indexed commit, or the target whose last baseline did not fail
--   queued           target_commit_sha moved to the head and a repository_indexing job was queued
-- Every outcome except the first two advances synced_generation to the observed generation, never
-- backwards, so a push marked after the observation stays pending. A head equal to a target whose
-- baseline failed is queued again, once per new push generation.

create function public.follow_repository_head(
  p_workspace_id uuid,
  p_commit_sha text,
  p_observed_generation bigint
)
returns table (job_id uuid, outcome text)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_workspace public.workspaces;
  v_commit public.git_commit_sha := p_commit_sha;
  v_last_status public.job_status;
  v_job_id uuid;
begin
  select * into v_workspace
  from public.workspaces as w
  where w.id = p_workspace_id
  for update;

  if not found or v_workspace.status <> 'ready' then
    return query select null::uuid, 'not_ready'::text;
    return;
  end if;

  if exists (
    select 1 from public.jobs as j
    where j.workspace_id = p_workspace_id
      and j.type in ('repository_indexing', 'deep_analysis', 'code_indexing')
      and j.status in ('queued', 'running')
  ) then
    return query select null::uuid, 'analysis_active'::text;
    return;
  end if;

  select j.status into v_last_status
  from public.jobs as j
  where j.workspace_id = p_workspace_id
    and j.type = 'repository_indexing'
    and j.repository_commit_sha = v_commit
  order by j.created_at desc, j.id desc
  limit 1;

  if v_commit is distinct from v_workspace.indexed_commit_sha
    and not (v_commit = v_workspace.target_commit_sha and coalesce(v_last_status, 'failed') <> 'failed')
  then
    insert into public.jobs (user_id, workspace_id, type, status, repository_commit_sha)
    values (v_workspace.user_id, p_workspace_id, 'repository_indexing', 'queued', v_commit)
    on conflict (workspace_id) where type = 'repository_indexing' and status in ('queued', 'running')
    do nothing
    returning id into v_job_id;

    if v_job_id is null then
      return query select null::uuid, 'analysis_active'::text;
      return;
    end if;
  end if;

  update public.workspaces as w
  set target_commit_sha = v_commit,
      synced_generation = greatest(w.synced_generation, least(p_observed_generation, w.push_generation))
  where w.id = p_workspace_id;

  return query select v_job_id, case when v_job_id is null then 'up_to_date' else 'queued' end;
end;
$$;

-- reopen_push_sync ------------------------------------------------------------------
-- Makes a push pending again after its analysis could not be enqueued. Only undoes the sync that
-- observed p_observed_generation, never a newer one. Returns true when the marker was reopened.

create function public.reopen_push_sync(
  p_workspace_id uuid,
  p_observed_generation bigint
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.workspaces as w
  set synced_generation = p_observed_generation - 1
  where w.id = p_workspace_id
    and p_observed_generation > 0
    and w.synced_generation = p_observed_generation;
  return found;
end;
$$;

-- list_pending_push_workspaces ------------------------------------------------------
-- Ready workspaces with a pending push whose connection is usable and that have no queued or
-- running baseline, deep analysis or code index, oldest pending first.

create function public.list_pending_push_workspaces(p_limit integer default 100)
returns table (workspace_id uuid, installation_id bigint, push_generation bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  select w.id, c.installation_id, w.push_generation
  from public.workspaces as w
  join public.repositories as r on r.id = w.repository_id and r.user_id = w.user_id
  join public.github_connections as c on c.id = r.github_connection_id and c.user_id = r.user_id
  where w.status = 'ready'
    and w.push_generation > w.synced_generation
    and c.suspended_at is null
    and not exists (
      select 1 from public.jobs as j
      where j.workspace_id = w.id
        and j.type in ('repository_indexing', 'deep_analysis', 'code_indexing')
        and j.status in ('queued', 'running')
    )
  order by w.updated_at, w.id
  limit least(greatest(coalesce(p_limit, 100), 1), 500);
$$;

create index workspaces_pending_push_idx on public.workspaces (updated_at, id)
  where push_generation > synced_generation;

-- load_reusable_code_files ----------------------------------------------------------
-- Stored facts for files whose blob is unchanged, so a followed commit only fetches and parses
-- changed files. p_files: jsonb array (at most 100) of {path, blob_sha}. A row is reused only on
-- an exact match of path, blob_sha and parser version (the path decides the language and the
-- payload's path), from any commit of the workspace. Transient outcomes (fetch_failed,
-- internal_error) are never reused. Returns a jsonb array of replace_code_index file payloads,
-- one per matched path; resolved_path values are stored ones and must be recomputed by the caller
-- against the new commit's tree.
-- Errors: 22023 invalid_code_index_payload.

create function public.load_reusable_code_files(
  p_workspace_id uuid,
  p_parser_version text,
  p_files jsonb
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if p_parser_version is null or jsonb_typeof(p_files) is distinct from 'array'
    or jsonb_array_length(p_files) > 100
    or exists (
      select 1 from jsonb_array_elements(p_files) as f(value)
      where jsonb_typeof(f.value) <> 'object'
        or jsonb_typeof(f.value -> 'path') is distinct from 'string'
        or jsonb_typeof(f.value -> 'blob_sha') is distinct from 'string'
    )
  then
    raise exception using errcode = '22023', message = 'invalid_code_index_payload';
  end if;

  return (
    select coalesce(jsonb_agg(
        jsonb_build_object(
          'path', f.path,
          'blob_sha', f.blob_sha,
          'language', f.language,
          'size_bytes', f.size_bytes,
          'line_count', f.line_count,
          'parse_status', f.parse_status,
          'parse_error_count', f.parse_error_count,
          'skipped_reason', f.skipped_reason,
          'stats', f.stats,
          'symbols', coalesce((
            select jsonb_agg(jsonb_build_object(
              'name', s.name, 'kind', s.kind, 'parent_ord', s.parent_ord,
              'start_line', s.start_line, 'start_col', s.start_col, 'end_line', s.end_line, 'end_col', s.end_col,
              'exported', s.exported, 'signature', s.signature
            ) order by s.ord)
            from public.code_symbols as s where s.file_id = f.id
          ), '[]'::jsonb),
          'imports', coalesce((
            select jsonb_agg(jsonb_build_object(
              'source', i.source, 'kind', i.kind, 'names', to_jsonb(i.names),
              'resolved_path', i.resolved_path, 'line', i.line
            ) order by i.ord)
            from public.code_imports as i where i.file_id = f.id
          ), '[]'::jsonb),
          'calls', coalesce((
            select jsonb_agg(jsonb_build_object(
              'caller_ord', c.caller_ord, 'callee_text', c.callee_text, 'line', c.line, 'col', c.col
            ) order by c.ord)
            from public.code_calls as c where c.file_id = f.id
          ), '[]'::jsonb)
        ) order by f.path
      ), '[]'::jsonb)
    from (
      select distinct on (q.path) c.*
      from (
        select distinct x.path, x.blob_sha
        from jsonb_to_recordset(p_files) as x(path text, blob_sha text)
      ) as q
      join public.code_files as c
        on c.workspace_id = p_workspace_id
       and c.blob_sha = q.blob_sha
       and c.parser_version = p_parser_version
       and c.path = q.path
      where coalesce(c.skipped_reason, '') not in ('fetch_failed', 'internal_error')
      order by q.path, c.created_at desc, c.repository_commit_sha
    ) as f
  );
end;
$$;

-- Grants --------------------------------------------------------------------

revoke execute on function public.mark_push_received(bigint, bigint) from public, anon, authenticated;
grant execute on function public.mark_push_received(bigint, bigint) to service_role;

revoke execute on function public.follow_repository_head(uuid, text, bigint) from public, anon, authenticated;
grant execute on function public.follow_repository_head(uuid, text, bigint) to service_role;

revoke execute on function public.reopen_push_sync(uuid, bigint) from public, anon, authenticated;
grant execute on function public.reopen_push_sync(uuid, bigint) to service_role;

revoke execute on function public.list_pending_push_workspaces(integer) from public, anon, authenticated;
grant execute on function public.list_pending_push_workspaces(integer) to service_role;

revoke execute on function public.load_reusable_code_files(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.load_reusable_code_files(uuid, text, jsonb) to service_role;
