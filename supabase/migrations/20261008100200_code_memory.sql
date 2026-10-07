-- Code index memory, symbol search, and symbol-aware evidence.
-- code_module rows (one per directory) and code-index file_summary rows are written by
-- save_code_memory and enter the existing embedding pipeline. Both are per-path, so neither is
-- covered by the one-row-per-kind index; the functions whose `on conflict` clause infers that
-- index are re-declared with the new predicate (bodies otherwise unchanged).

-- repository_memory ---------------------------------------------------------

alter table public.repository_memory
  drop constraint repository_memory_kind_check,
  add constraint repository_memory_kind_check check (kind in (
    'architecture_summary',
    'technologies',
    'modules',
    'key_files',
    'concepts',
    'dependencies',
    'configuration',
    'file_summary',
    'code_index',
    'code_module'
  ));

drop index public.repository_memory_workspace_commit_kind_key;

create unique index repository_memory_workspace_commit_kind_key
  on public.repository_memory (workspace_id, repository_commit_sha, kind)
  where kind not in ('file_summary', 'code_module');

create or replace function public.complete_repository_analysis(
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
  on conflict (workspace_id, repository_commit_sha, kind) where kind not in ('file_summary', 'code_module') do nothing;

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

create or replace function public.save_deep_analysis(
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
  on conflict (workspace_id, repository_commit_sha, kind) where kind not in ('file_summary', 'code_module') do update
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

create or replace function public.complete_code_index(
  p_workspace_id uuid,
  p_job_id uuid,
  p_commit_sha text,
  p_parser_version text,
  p_summary jsonb
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_workspace public.workspaces;
  v_counts jsonb;
begin
  if p_summary is null or jsonb_typeof(p_summary) <> 'object'
    or p_parser_version is null or char_length(p_parser_version) not between 1 and 64
  then
    raise exception using errcode = '22023', message = 'invalid_code_index_summary';
  end if;

  select w.* into v_workspace
  from public.jobs as j
  join public.workspaces as w on w.id = j.workspace_id and w.user_id = j.user_id
  where j.id = p_job_id
    and j.workspace_id = p_workspace_id
    and j.type = 'code_indexing'
    and j.repository_commit_sha = p_commit_sha;

  if not found then
    raise exception using errcode = 'P0002', message = 'code_index_job_not_found';
  end if;

  select jsonb_build_object(
    'files', count(*),
    'ok', count(*) filter (where f.parse_status = 'ok'),
    'partial', count(*) filter (where f.parse_status = 'partial'),
    'failed', count(*) filter (where f.parse_status = 'failed'),
    'unsupported', count(*) filter (where f.parse_status = 'unsupported'),
    'skipped', count(*) filter (where f.parse_status = 'skipped')
  )
  into v_counts
  from public.code_files as f
  where f.workspace_id = p_workspace_id and f.repository_commit_sha = p_commit_sha;

  select v_counts || jsonb_build_object(
    'languages', coalesce((
      select jsonb_object_agg(l.language, l.files)
      from (
        select f.language, count(*) as files
        from public.code_files as f
        where f.workspace_id = p_workspace_id and f.repository_commit_sha = p_commit_sha and f.language is not null
        group by f.language
      ) as l
    ), '{}'::jsonb),
    'symbols', (select count(*) from public.code_symbols as s where s.workspace_id = p_workspace_id and s.repository_commit_sha = p_commit_sha),
    'imports', (select count(*) from public.code_imports as i where i.workspace_id = p_workspace_id and i.repository_commit_sha = p_commit_sha),
    'calls', (select count(*) from public.code_calls as c where c.workspace_id = p_workspace_id and c.repository_commit_sha = p_commit_sha)
  )
  into v_counts;

  insert into public.repository_memory
    (workspace_id, repository_id, user_id, repository_commit_sha, kind, content, structured, metadata)
  values (
    v_workspace.id,
    v_workspace.repository_id,
    v_workspace.user_id,
    p_commit_sha,
    'code_index',
    '',
    p_summary || jsonb_build_object('counts', v_counts),
    jsonb_build_object(
      'source', 'code_index',
      'parser_version', p_parser_version,
      'commit_sha', p_commit_sha,
      'completed_at', now()
    )
  )
  on conflict (workspace_id, repository_commit_sha, kind) where kind not in ('file_summary', 'code_module') do update
  set content = excluded.content,
      structured = excluded.structured,
      metadata = excluded.metadata;

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

-- save_code_memory --------------------------------------------------------------
-- Replaces the code index's memory rows (metadata.source = 'code_index') for one commit.
-- p_rows: jsonb array (at most 200) of {kind: code_module|file_summary, content (1..8000 chars),
-- structured: {path, ...}, metadata?, token_count?}; (kind, structured.path) is unique.
-- A stored row with the same kind, path and content is kept with its embedding (structured and
-- metadata are refreshed, the embedding marker is preserved); any other code-index row of the
-- commit is deleted. New rows get created_at offset by their array position, so readers ordering
-- by created_at see them in the given (relevance) order. Rows from other sources are never touched.
-- Returns the number of rows inserted.
-- Errors:
--   22023 invalid_code_memory_payload
--   22023 duplicate_code_memory_path
--   P0002 code_index_job_not_found

create function public.save_code_memory(
  p_workspace_id uuid,
  p_job_id uuid,
  p_commit_sha text,
  p_rows jsonb
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_workspace public.workspaces;
  v_inserted integer;
begin
  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'invalid_code_memory_payload';
  end if;

  if jsonb_array_length(p_rows) > 200 or exists (
    select 1 from jsonb_array_elements(p_rows) as r(value)
    where jsonb_typeof(r.value) <> 'object'
      or coalesce(r.value ->> 'kind', '') not in ('code_module', 'file_summary')
      or jsonb_typeof(r.value -> 'content') is distinct from 'string'
      or char_length(r.value ->> 'content') not between 1 and 8000
      or jsonb_typeof(r.value -> 'structured') is distinct from 'object'
      or jsonb_typeof(r.value -> 'structured' -> 'path') is distinct from 'string'
      or jsonb_typeof(coalesce(r.value -> 'metadata', '{}')) <> 'object'
  ) then
    raise exception using errcode = '22023', message = 'invalid_code_memory_payload';
  end if;

  if (
    select count(distinct (r.value ->> 'kind', r.value -> 'structured' ->> 'path'))
    from jsonb_array_elements(p_rows) as r(value)
  ) <> jsonb_array_length(p_rows) then
    raise exception using errcode = '22023', message = 'duplicate_code_memory_path';
  end if;

  select w.* into v_workspace
  from public.jobs as j
  join public.workspaces as w on w.id = j.workspace_id and w.user_id = j.user_id
  where j.id = p_job_id
    and j.workspace_id = p_workspace_id
    and j.type = 'code_indexing'
    and j.repository_commit_sha = p_commit_sha;

  if not found then
    raise exception using errcode = 'P0002', message = 'code_index_job_not_found';
  end if;

  delete from public.repository_memory as m
  where m.workspace_id = p_workspace_id
    and m.repository_commit_sha = p_commit_sha
    and m.kind in ('code_module', 'file_summary')
    and m.metadata ->> 'source' = 'code_index'
    and not exists (
      select 1 from jsonb_array_elements(p_rows) as r(value)
      where r.value ->> 'kind' = m.kind
        and r.value -> 'structured' ->> 'path' = m.structured ->> 'path'
        and r.value ->> 'content' = m.content
    );

  update public.repository_memory as m
  set structured = r.value -> 'structured',
      metadata = m.metadata || coalesce(r.value -> 'metadata', '{}'),
      token_count = (r.value ->> 'token_count')::integer
  from jsonb_array_elements(p_rows) as r(value)
  where m.workspace_id = p_workspace_id
    and m.repository_commit_sha = p_commit_sha
    and m.metadata ->> 'source' = 'code_index'
    and m.kind = r.value ->> 'kind'
    and m.structured ->> 'path' = r.value -> 'structured' ->> 'path'
    and m.content = r.value ->> 'content'
    and (
      m.structured is distinct from r.value -> 'structured'
      or not m.metadata @> coalesce(r.value -> 'metadata', '{}')
      or m.token_count is distinct from (r.value ->> 'token_count')::integer
    );

  insert into public.repository_memory (
    workspace_id, repository_id, user_id, repository_commit_sha, kind, content, structured, metadata,
    token_count, created_at
  )
  select
    v_workspace.id,
    v_workspace.repository_id,
    v_workspace.user_id,
    p_commit_sha,
    r.value ->> 'kind',
    r.value ->> 'content',
    r.value -> 'structured',
    coalesce(r.value -> 'metadata', '{}') || jsonb_build_object('source', 'code_index'),
    (r.value ->> 'token_count')::integer,
    now() + (r.ord * interval '1 microsecond')
  from jsonb_array_elements(p_rows) with ordinality as r(value, ord)
  where not exists (
    select 1 from public.repository_memory as m
    where m.workspace_id = p_workspace_id
      and m.repository_commit_sha = p_commit_sha
      and m.metadata ->> 'source' = 'code_index'
      and m.kind = r.value ->> 'kind'
      and m.structured ->> 'path' = r.value -> 'structured' ->> 'path'
      and m.content = r.value ->> 'content'
  );
  get diagnostics v_inserted = row_count;

  return v_inserted;
end;
$$;

-- search_code_symbols -----------------------------------------------------------
-- Keyword layer for search_repository: symbols of one commit whose name contains any of
-- p_terms (case-insensitive, 2..64 chars, at most 12 used). Ranked by how many terms the name
-- contains, exported first, then shorter names. Name-based and unresolved, like find_symbol.

create function public.search_code_symbols(
  p_workspace_id uuid,
  p_commit_sha text,
  p_terms text[],
  p_limit integer default 20
)
returns table (
  path text,
  language text,
  name text,
  kind text,
  parent_name text,
  start_line integer,
  end_line integer,
  exported boolean,
  signature text,
  matched_terms integer
)
language sql
stable
security invoker
set search_path = ''
as $$
  with terms as (
    select distinct lower(t.term) as term
    from unnest(coalesce(p_terms, '{}')) as t(term)
    where char_length(t.term) between 2 and 64
    limit 12
  ),
  hits as (
    select s.*, (select count(*) from terms where strpos(lower(s.name), terms.term) > 0)::integer as matched
    from public.code_symbols as s
    where s.workspace_id = p_workspace_id
      and s.repository_commit_sha = p_commit_sha
  )
  select
    f.path, f.language, h.name, h.kind, p.name, h.start_line, h.end_line, h.exported, h.signature, h.matched
  from hits as h
  join public.code_files as f on f.id = h.file_id
  left join public.code_symbols as p on p.file_id = h.file_id and p.ord = h.parent_ord
  where h.matched > 0
  order by h.matched desc, h.exported desc, char_length(h.name), f.path, h.start_line, h.start_col
  limit least(greatest(coalesce(p_limit, 20), 1), 50);
$$;

-- record_evidence_examined ------------------------------------------------------
-- Also keeps the optional symbol-level trace {symbol, startLine, endLine, commit_sha}; a field
-- that is not well-formed is dropped on its own. Still one event per path per interview: the
-- first examination's range is the one kept.

create or replace function public.record_evidence_examined(
  p_interview_id uuid,
  p_user_id uuid,
  p_evidence jsonb
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_item jsonb;
  v_path text;
  v_count integer := 0;
begin
  if p_evidence is null or jsonb_typeof(p_evidence) <> 'array' then
    return 0;
  end if;

  perform pg_advisory_xact_lock(hashtext('interview_events'), hashtext(p_interview_id::text));

  for v_item in select value from jsonb_array_elements(p_evidence) limit 20 loop
    v_path := nullif(v_item ->> 'path', '');
    if v_path is null or v_item ->> 'tool' not in ('get_file', 'search_repository') then
      continue;
    end if;
    if exists (
      select 1 from public.interview_events as e
      where e.interview_id = p_interview_id
        and e.event_type = 'evidence_examined'
        and e.payload ->> 'path' = v_path
    ) then
      continue;
    end if;

    insert into public.interview_events (interview_id, user_id, sequence, event_type, payload)
    select
      p_interview_id,
      p_user_id,
      coalesce(max(e.sequence), 0) + 1,
      'evidence_examined',
      jsonb_strip_nulls(jsonb_build_object(
        'path', v_path,
        'area', v_item ->> 'area',
        'tool', v_item ->> 'tool',
        'symbol', case
          when jsonb_typeof(v_item -> 'symbol') = 'string' and char_length(v_item ->> 'symbol') between 1 and 256
          then v_item ->> 'symbol'
        end,
        'startLine', case
          when jsonb_typeof(v_item -> 'startLine') = 'number' and (v_item ->> 'startLine') ~ '^[1-9][0-9]{0,8}$'
          then (v_item ->> 'startLine')::integer
        end,
        'endLine', case
          when jsonb_typeof(v_item -> 'endLine') = 'number' and (v_item ->> 'endLine') ~ '^[1-9][0-9]{0,8}$'
          then (v_item ->> 'endLine')::integer
        end,
        'commit_sha', case
          when jsonb_typeof(v_item -> 'commit_sha') = 'string' and (v_item ->> 'commit_sha') ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'
          then v_item ->> 'commit_sha'
        end
      ))
    from public.interview_events as e
    where e.interview_id = p_interview_id;

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

-- Grants --------------------------------------------------------------------

revoke execute on function public.save_code_memory(uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.save_code_memory(uuid, uuid, text, jsonb) to service_role;

revoke execute on function public.search_code_symbols(uuid, text, text[], integer) from public, anon;
grant execute on function public.search_code_symbols(uuid, text, text[], integer) to authenticated, service_role;
