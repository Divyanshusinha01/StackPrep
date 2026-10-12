-- Cross-file call graph for the commit-pinned code index.
-- The link step of the code-index job runs @stackprep/code-parser's resolveProject over a commit's
-- stored facts and writes one row per (call site, target symbol) to code_call_edges: a single
-- `resolved` row, or one `ambiguous` row per kept candidate. Unresolved calls get no rows, and
-- find_callers falls back to name matching for them. Resolution is heuristic (imports, scopes and
-- names; no types, overloads, preprocessor or build configuration), so results carry confidence.
-- Ownership mirrors the other code index tables: composite FKs to code_files, owner-select RLS,
-- writes only through service-role functions.

-- code_imports.resolution ----------------------------------------------------
-- How the specifier resolved against the commit's paths. Null for rows written before this column.

alter table public.code_imports
  add column resolution text check (resolution in ('resolved', 'external', 'unresolved', 'ambiguous'));

-- code_calls.callee_name -----------------------------------------------------
-- Last segment across `.`, `::` and `->` (`app::Store::make` -> `make`), so C++ calls match by name.

drop index public.code_calls_callee_name_idx;
alter table public.code_calls drop column callee_name;
alter table public.code_calls
  add column callee_name text not null generated always as (lower(regexp_replace(callee_text, '^.*([.]|::|->)', ''))) stored;
create index code_calls_callee_name_idx on public.code_calls (workspace_id, repository_commit_sha, callee_name);

-- code_call_edges -------------------------------------------------------------
-- call_ord is code_calls.ord in file_id; target_ord is code_symbols.ord in target_file_id. Rows
-- cascade away with either file, so replacing a file's facts drops edges into and out of it until
-- the next link step rebuilds them.

create table public.code_call_edges (
  id bigint generated always as identity primary key,
  file_id uuid not null,
  workspace_id uuid not null,
  user_id uuid not null,
  repository_commit_sha public.git_commit_sha not null,
  call_ord integer not null check (call_ord >= 0),
  target_file_id uuid not null,
  target_ord integer not null check (target_ord >= 0),
  confidence text not null check (confidence in ('resolved', 'ambiguous')),
  -- Total candidates for the call site; ambiguous calls keep only the first few as rows.
  candidate_count integer not null check (candidate_count >= 1),
  unique (file_id, call_ord, target_file_id, target_ord),
  foreign key (file_id, workspace_id, repository_commit_sha, user_id)
    references public.code_files (id, workspace_id, repository_commit_sha, user_id)
    on delete cascade,
  foreign key (target_file_id, workspace_id, repository_commit_sha, user_id)
    references public.code_files (id, workspace_id, repository_commit_sha, user_id)
    on delete cascade,
  foreign key (file_id, call_ord)
    references public.code_calls (file_id, ord)
    on delete cascade,
  foreign key (target_file_id, target_ord)
    references public.code_symbols (file_id, ord)
    on delete cascade,
  check (confidence <> 'resolved' or candidate_count = 1)
);

create index code_call_edges_target_idx
  on public.code_call_edges (workspace_id, repository_commit_sha, target_file_id, target_ord);
create index code_call_edges_target_file_idx on public.code_call_edges (target_file_id, target_ord);

alter table public.code_call_edges enable row level security;

revoke all on public.code_call_edges from anon, authenticated;
grant select on public.code_call_edges to authenticated;

create policy "Users can read their own code call edges"
  on public.code_call_edges for select to authenticated
  using (user_id = (select auth.uid()));

-- replace_code_index ----------------------------------------------------------
-- Unchanged except that imports may carry `resolution`.

create or replace function public.replace_code_index(
  p_workspace_id uuid,
  p_commit_sha text,
  p_parser_version text,
  p_files jsonb
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_workspace public.workspaces;
  v_commit public.git_commit_sha := p_commit_sha;
  v_file jsonb;
  v_hash text;
  v_existing_id uuid;
  v_existing_hash text;
  v_file_id uuid;
  v_written integer := 0;
begin
  if p_parser_version is null or char_length(p_parser_version) not between 1 and 64
    or jsonb_typeof(p_files) is distinct from 'array'
  then
    raise exception using errcode = '22023', message = 'invalid_code_index_payload';
  end if;

  if jsonb_array_length(p_files) > 100 or exists (
    select 1 from jsonb_array_elements(p_files) as f(value)
    where jsonb_typeof(f.value) <> 'object'
      or jsonb_typeof(f.value -> 'path') is distinct from 'string'
      or jsonb_typeof(f.value -> 'blob_sha') is distinct from 'string'
      or jsonb_typeof(f.value -> 'parse_status') is distinct from 'string'
      or jsonb_typeof(coalesce(f.value -> 'symbols', '[]')) <> 'array'
      or jsonb_typeof(coalesce(f.value -> 'imports', '[]')) <> 'array'
      or jsonb_typeof(coalesce(f.value -> 'calls', '[]')) <> 'array'
  ) then
    raise exception using errcode = '22023', message = 'invalid_code_index_payload';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_files) as f(value)
    where jsonb_array_length(coalesce(f.value -> 'symbols', '[]')) > 5000
      or jsonb_array_length(coalesce(f.value -> 'imports', '[]')) > 2000
      or jsonb_array_length(coalesce(f.value -> 'calls', '[]')) > 5000
  ) then
    raise exception using errcode = '22023', message = 'invalid_code_index_payload';
  end if;

  if (select count(distinct f.value ->> 'path') from jsonb_array_elements(p_files) as f(value))
    <> jsonb_array_length(p_files)
  then
    raise exception using errcode = '22023', message = 'duplicate_code_file_path';
  end if;

  select * into v_workspace
  from public.workspaces as w
  where w.id = p_workspace_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'workspace_not_found';
  end if;

  for v_file in
    select f.value from jsonb_array_elements(p_files) as f(value) order by f.value ->> 'path'
  loop
    v_hash := md5(p_parser_version || E'\n' || v_file::text);

    select c.id, c.facts_hash into v_existing_id, v_existing_hash
    from public.code_files as c
    where c.workspace_id = p_workspace_id
      and c.repository_commit_sha = v_commit
      and c.path = v_file ->> 'path';

    if found and v_existing_hash = v_hash then
      continue;
    end if;

    if found then
      delete from public.code_files where id = v_existing_id;
    end if;

    insert into public.code_files (
      workspace_id, repository_id, user_id, repository_commit_sha, path, blob_sha, language,
      size_bytes, line_count, parse_status, parse_error_count, skipped_reason, parser_version,
      facts_hash, stats
    )
    values (
      v_workspace.id,
      v_workspace.repository_id,
      v_workspace.user_id,
      v_commit,
      v_file ->> 'path',
      v_file ->> 'blob_sha',
      v_file ->> 'language',
      (v_file ->> 'size_bytes')::integer,
      (v_file ->> 'line_count')::integer,
      v_file ->> 'parse_status',
      coalesce((v_file ->> 'parse_error_count')::integer, 0),
      v_file ->> 'skipped_reason',
      p_parser_version,
      v_hash,
      coalesce(v_file -> 'stats', '{}'::jsonb)
    )
    returning id into v_file_id;

    insert into public.code_symbols (
      file_id, workspace_id, user_id, repository_commit_sha, ord, name, kind, parent_ord,
      start_line, start_col, end_line, end_col, exported, signature
    )
    select
      v_file_id, v_workspace.id, v_workspace.user_id, v_commit, (s.ord - 1)::integer,
      s.value ->> 'name',
      s.value ->> 'kind',
      (s.value ->> 'parent_ord')::integer,
      (s.value ->> 'start_line')::integer,
      (s.value ->> 'start_col')::integer,
      (s.value ->> 'end_line')::integer,
      (s.value ->> 'end_col')::integer,
      coalesce((s.value ->> 'exported')::boolean, false),
      s.value ->> 'signature'
    from jsonb_array_elements(coalesce(v_file -> 'symbols', '[]')) with ordinality as s(value, ord);

    insert into public.code_imports (
      file_id, workspace_id, user_id, repository_commit_sha, ord, source, kind, names, resolved_path, resolution, line
    )
    select
      v_file_id, v_workspace.id, v_workspace.user_id, v_commit, (i.ord - 1)::integer,
      i.value ->> 'source',
      coalesce(i.value ->> 'kind', 'static'),
      array(select jsonb_array_elements_text(coalesce(i.value -> 'names', '[]'))),
      i.value ->> 'resolved_path',
      i.value ->> 'resolution',
      (i.value ->> 'line')::integer
    from jsonb_array_elements(coalesce(v_file -> 'imports', '[]')) with ordinality as i(value, ord);

    insert into public.code_calls (
      file_id, workspace_id, user_id, repository_commit_sha, ord, caller_ord, callee_text, line, col
    )
    select
      v_file_id, v_workspace.id, v_workspace.user_id, v_commit, (c.ord - 1)::integer,
      (c.value ->> 'caller_ord')::integer,
      c.value ->> 'callee_text',
      (c.value ->> 'line')::integer,
      (c.value ->> 'col')::integer
    from jsonb_array_elements(coalesce(v_file -> 'calls', '[]')) with ordinality as c(value, ord);

    v_written := v_written + 1;
  end loop;

  return v_written;
end;
$$;

-- load_code_link_facts ----------------------------------------------------------
-- One page of a commit's parsed files (ok or partial) in path order, after p_after_path, with the
-- facts the resolver needs: symbols {name, kind, parent_ord, exported, signature}, imports
-- {source, kind, names} and calls {caller_ord, callee_text}, each in ord order. Page size is
-- clamped to 1..200. Returns a jsonb array; an empty array ends paging.

create function public.load_code_link_facts(
  p_workspace_id uuid,
  p_commit_sha text,
  p_after_path text default null,
  p_limit integer default 100
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'path', f.path,
      'language', f.language,
      'symbols', coalesce((
        select jsonb_agg(jsonb_build_object(
          'name', s.name, 'kind', s.kind, 'parent_ord', s.parent_ord, 'exported', s.exported, 'signature', s.signature
        ) order by s.ord)
        from public.code_symbols as s where s.file_id = f.id
      ), '[]'::jsonb),
      'imports', coalesce((
        select jsonb_agg(jsonb_build_object('source', i.source, 'kind', i.kind, 'names', to_jsonb(i.names)) order by i.ord)
        from public.code_imports as i where i.file_id = f.id
      ), '[]'::jsonb),
      'calls', coalesce((
        select jsonb_agg(jsonb_build_object('caller_ord', c.caller_ord, 'callee_text', c.callee_text) order by c.ord)
        from public.code_calls as c where c.file_id = f.id
      ), '[]'::jsonb)
    ) order by f.path
  ), '[]'::jsonb)
  from (
    select c.id, c.path, c.language
    from public.code_files as c
    where c.workspace_id = p_workspace_id
      and c.repository_commit_sha = p_commit_sha
      and c.parse_status in ('ok', 'partial')
      and (p_after_path is null or c.path > p_after_path)
    order by c.path
    limit least(greatest(coalesce(p_limit, 100), 1), 200)
  ) as f;
$$;

-- replace_code_edges -----------------------------------------------------------
-- Replaces the outgoing edges of each listed source file at one commit. p_files: jsonb array (at
-- most 100 files, 20000 edges in total) of {
--   path, edges: [{call_ord, target_path, target_ord, confidence, candidate_count}]
-- }
-- A listed file with no edges has its edges cleared; unlisted files are untouched. The same input
-- always yields the same rows. Returns the number of edges inserted.
-- Errors (message is the code):
--   22023 invalid_code_edges_payload  payload is not the shape above
--   22023 duplicate_code_file_path    the batch lists the same source path twice
--   P0002 workspace_not_found
--   P0002 code_file_not_found         a source or target path is not indexed at the commit
-- Constraint violations (unknown call or symbol ordinal, bad confidence) raise as usual.

create function public.replace_code_edges(
  p_workspace_id uuid,
  p_commit_sha text,
  p_files jsonb
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_workspace public.workspaces;
  v_commit public.git_commit_sha := p_commit_sha;
  v_written integer;
begin
  if jsonb_typeof(p_files) is distinct from 'array' or jsonb_array_length(p_files) > 100 or exists (
    select 1 from jsonb_array_elements(p_files) as f(value)
    where jsonb_typeof(f.value) <> 'object'
      or jsonb_typeof(f.value -> 'path') is distinct from 'string'
      or jsonb_typeof(coalesce(f.value -> 'edges', '[]')) <> 'array'
  ) then
    raise exception using errcode = '22023', message = 'invalid_code_edges_payload';
  end if;

  if (select coalesce(sum(jsonb_array_length(coalesce(f.value -> 'edges', '[]'))), 0)
      from jsonb_array_elements(p_files) as f(value)) > 20000
    or exists (
      select 1
      from jsonb_array_elements(p_files) as f(value),
           jsonb_array_elements(coalesce(f.value -> 'edges', '[]')) as e(value)
      where jsonb_typeof(e.value) <> 'object'
        or jsonb_typeof(e.value -> 'call_ord') is distinct from 'number'
        or jsonb_typeof(e.value -> 'target_path') is distinct from 'string'
        or jsonb_typeof(e.value -> 'target_ord') is distinct from 'number'
        or jsonb_typeof(e.value -> 'confidence') is distinct from 'string'
        or jsonb_typeof(e.value -> 'candidate_count') is distinct from 'number'
    )
  then
    raise exception using errcode = '22023', message = 'invalid_code_edges_payload';
  end if;

  if (select count(distinct f.value ->> 'path') from jsonb_array_elements(p_files) as f(value))
    <> jsonb_array_length(p_files)
  then
    raise exception using errcode = '22023', message = 'duplicate_code_file_path';
  end if;

  select * into v_workspace
  from public.workspaces as w
  where w.id = p_workspace_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'workspace_not_found';
  end if;

  if exists (
    select 1
    from (
      select f.value ->> 'path' as path from jsonb_array_elements(p_files) as f(value)
      union
      select e.value ->> 'target_path'
      from jsonb_array_elements(p_files) as f(value),
           jsonb_array_elements(coalesce(f.value -> 'edges', '[]')) as e(value)
    ) as p
    where not exists (
      select 1 from public.code_files as c
      where c.workspace_id = p_workspace_id and c.repository_commit_sha = v_commit and c.path = p.path
    )
  ) then
    raise exception using errcode = 'P0002', message = 'code_file_not_found';
  end if;

  delete from public.code_call_edges as e
  using public.code_files as c
  where e.file_id = c.id
    and c.workspace_id = p_workspace_id
    and c.repository_commit_sha = v_commit
    and c.path in (select f.value ->> 'path' from jsonb_array_elements(p_files) as f(value));

  insert into public.code_call_edges (
    file_id, workspace_id, user_id, repository_commit_sha, call_ord, target_file_id, target_ord, confidence, candidate_count
  )
  select
    src.id, v_workspace.id, v_workspace.user_id, v_commit,
    (e.value ->> 'call_ord')::integer,
    tgt.id,
    (e.value ->> 'target_ord')::integer,
    e.value ->> 'confidence',
    (e.value ->> 'candidate_count')::integer
  from jsonb_array_elements(p_files) as f(value)
  cross join lateral jsonb_array_elements(coalesce(f.value -> 'edges', '[]')) as e(value)
  join public.code_files as src
    on src.workspace_id = p_workspace_id and src.repository_commit_sha = v_commit and src.path = f.value ->> 'path'
  join public.code_files as tgt
    on tgt.workspace_id = p_workspace_id and tgt.repository_commit_sha = v_commit and tgt.path = e.value ->> 'target_path'
  order by src.path, (e.value ->> 'call_ord')::integer, tgt.path, (e.value ->> 'target_ord')::integer;
  get diagnostics v_written = row_count;

  return v_written;
end;
$$;

-- find_callers ------------------------------------------------------------------
-- Callers of a symbol. The wanted name is p_symbol when given, else p_name; `Parent.name` or
-- `Parent::name` also requires the parent (or a C++ out-of-line `Parent::name` signature), and
-- p_file restricts targets to one file. Rows come in two tiers:
--   1. call sites with an edge to a matching symbol: resolved = true for `resolved` edges, false
--      with confidence 'ambiguous' when the symbol is one of several candidates;
--   2. name matches (callee's last segment, case-insensitive) without any such edge and not
--      resolved to a different symbol: resolved = false, confidence null.
-- Existing columns keep their meaning; the new ones are appended. The 4-argument form keeps the
-- original signature and calls this with no file or symbol.

drop function public.find_callers(uuid, text, text, integer);

create function public.find_callers(
  p_workspace_id uuid,
  p_commit_sha text,
  p_name text,
  p_limit integer,
  p_file text,
  p_symbol text
)
returns table (
  path text,
  caller_name text,
  caller_kind text,
  callee_text text,
  line integer,
  col integer,
  exact boolean,
  resolved boolean,
  confidence text,
  target_path text,
  target_name text
)
language sql
stable
security invoker
set search_path = ''
as $$
  with wanted as (
    select w.name, regexp_replace(w.name, '^.*([.]|::|->)', '') as leaf,
      nullif(regexp_replace(coalesce(substring(w.name from '^(.*)(?:[.]|::|->)'), ''), '^.*([.]|::|->)', ''), '') as parent
    from (select coalesce(nullif(p_symbol, ''), p_name) as name) as w
    where char_length(coalesce(w.name, '')) > 0
  ),
  targets as (
    select s.file_id, s.ord, f.path, s.name
    from wanted
    join public.code_symbols as s
      on s.workspace_id = p_workspace_id and s.repository_commit_sha = p_commit_sha and lower(s.name) = lower(wanted.leaf)
    join public.code_files as f on f.id = s.file_id
    left join public.code_symbols as p on p.file_id = s.file_id and p.ord = s.parent_ord
    where (p_file is null or f.path = p_file)
      and (
        wanted.parent is null
        or lower(p.name) = lower(wanted.parent)
        or strpos(lower(coalesce(s.signature, '')), lower(wanted.parent || '::' || wanted.leaf)) > 0
      )
  ),
  edge_calls as (
    select distinct on (e.file_id, e.call_ord) e.file_id, e.call_ord, e.confidence, t.path as target_path, t.name as target_name
    from public.code_call_edges as e
    join targets as t on t.file_id = e.target_file_id and t.ord = e.target_ord
    where e.workspace_id = p_workspace_id and e.repository_commit_sha = p_commit_sha
    order by e.file_id, e.call_ord, e.confidence = 'resolved' desc, t.path, t.name
  ),
  hits as (
    select f.path, s.name as caller_name, s.kind as caller_kind, c.callee_text, c.line, c.col,
      c.callee_text = (select name from wanted) as exact,
      ec.confidence = 'resolved' as resolved, ec.confidence, ec.target_path, ec.target_name, 0 as tier
    from edge_calls as ec
    join public.code_calls as c on c.file_id = ec.file_id and c.ord = ec.call_ord
    join public.code_files as f on f.id = c.file_id
    left join public.code_symbols as s on s.file_id = c.file_id and s.ord = c.caller_ord
    union all
    select f.path, s.name, s.kind, c.callee_text, c.line, c.col,
      c.callee_text = wanted.name,
      false, null, null, null, 1
    from wanted
    join public.code_calls as c
      on c.workspace_id = p_workspace_id and c.repository_commit_sha = p_commit_sha and c.callee_name = lower(wanted.leaf)
    join public.code_files as f on f.id = c.file_id
    left join public.code_symbols as s on s.file_id = c.file_id and s.ord = c.caller_ord
    where not exists (select 1 from edge_calls as ec where ec.file_id = c.file_id and ec.call_ord = c.ord)
      and not exists (
        select 1 from public.code_call_edges as e
        where e.file_id = c.file_id and e.call_ord = c.ord and e.confidence = 'resolved'
      )
  )
  select r.path, r.caller_name, r.caller_kind, r.callee_text, r.line, r.col, r.exact, r.resolved, r.confidence, r.target_path, r.target_name
  from hits as r
  order by r.tier, r.resolved desc, r.exact desc, r.path, r.line, r.col
  limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;

create function public.find_callers(
  p_workspace_id uuid,
  p_commit_sha text,
  p_name text,
  p_limit integer default 50
)
returns table (
  path text,
  caller_name text,
  caller_kind text,
  callee_text text,
  line integer,
  col integer,
  exact boolean,
  resolved boolean,
  confidence text,
  target_path text,
  target_name text
)
language sql
stable
security invoker
set search_path = ''
as $$
  select * from public.find_callers(p_workspace_id, p_commit_sha, p_name, p_limit, null::text, null::text);
$$;

-- Grants --------------------------------------------------------------------

revoke execute on function public.load_code_link_facts(uuid, text, text, integer) from public, anon, authenticated;
grant execute on function public.load_code_link_facts(uuid, text, text, integer) to service_role;

revoke execute on function public.replace_code_edges(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.replace_code_edges(uuid, text, jsonb) to service_role;

revoke execute on function public.find_callers(uuid, text, text, integer, text, text) from public, anon;
grant execute on function public.find_callers(uuid, text, text, integer, text, text) to authenticated, service_role;

revoke execute on function public.find_callers(uuid, text, text, integer) from public, anon;
grant execute on function public.find_callers(uuid, text, text, integer) to authenticated, service_role;
