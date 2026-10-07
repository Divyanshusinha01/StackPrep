-- Commit-pinned syntactic code index built from @stackprep/code-parser (Tree-sitter) facts.
-- Stores names, kinds, ranges and syntactic edges only, never source text. Facts are name-based
-- and unresolved: imports keep the specifier as written (resolved_path is a path-only guess for
-- relative specifiers) and calls keep the callee text as written.
-- Ownership mirrors repository_memory: composite FK to workspaces, owner-select RLS, and every
-- write goes through the service-role functions below. Child tables carry user_id so RLS needs
-- no joins; the composite FK to code_files keeps it consistent.

-- jobs ----------------------------------------------------------------------

alter table public.jobs
  drop constraint jobs_stage_check,
  add constraint jobs_stage_check
    check (stage is null or stage in (
      'scanning', 'analyzing', 'preparing_context', 'planning', 'reporting', 'deep_analysis', 'code_indexing'
    ));

-- At most one queued/running code index per workspace; request_code_index relies on it.
create unique index jobs_active_code_indexing_key
  on public.jobs (workspace_id)
  where type = 'code_indexing' and status in ('queued', 'running');

-- repository_memory ---------------------------------------------------------
-- `code_index`: one metadata-only row per indexed commit (empty content, so it is never embedded).

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
    'code_index'
  ));

-- code_files ----------------------------------------------------------------
-- One row per selected file per commit, including files that were skipped or failed to parse.
-- skipped_reason explains missing or partial facts: a skip reason (binary, secret, ...) or the
-- parser's failure reason (too_large, timeout, ...).

create table public.code_files (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  repository_id uuid not null,
  user_id uuid not null,
  repository_commit_sha public.git_commit_sha not null,
  path text not null check (char_length(path) between 1 and 1024),
  blob_sha text not null check (blob_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  language text check (language ~ '^[a-z][a-z0-9_-]{0,31}$'),
  size_bytes integer not null check (size_bytes >= 0),
  line_count integer check (line_count >= 0),
  parse_status text not null check (parse_status in ('ok', 'partial', 'failed', 'unsupported', 'skipped')),
  parse_error_count integer not null default 0 check (parse_error_count >= 0),
  skipped_reason text check (skipped_reason ~ '^[a-z][a-z0-9_]{0,63}$'),
  parser_version text not null check (char_length(parser_version) between 1 and 64),
  -- md5 of the parser version and the submitted file payload; an equal hash makes re-indexing a no-op.
  facts_hash text not null check (facts_hash ~ '^[0-9a-f]{32}$'),
  stats jsonb not null default '{}'::jsonb check (jsonb_typeof(stats) = 'object'),
  created_at timestamptz not null default now(),
  unique (workspace_id, repository_commit_sha, path),
  -- Target of the child tables' composite foreign keys.
  unique (id, workspace_id, repository_commit_sha, user_id),
  foreign key (workspace_id, repository_id, user_id)
    references public.workspaces (id, repository_id, user_id)
    on delete cascade,
  check (parse_status <> 'skipped' or skipped_reason is not null),
  check (parse_status not in ('ok', 'partial') or (skipped_reason is null and language is not null))
);

create index code_files_workspace_fk_idx on public.code_files (workspace_id, repository_id, user_id);
create index code_files_user_id_idx on public.code_files (user_id);
-- Lets indexing reuse facts for an unchanged blob from another commit.
create index code_files_blob_idx on public.code_files (workspace_id, blob_sha, parser_version);

-- code_symbols --------------------------------------------------------------
-- ord is the symbol's position in the parser output (source order, parents before children).
-- Lines and columns are 1-based, columns in UTF-16 code units, ends exclusive.

create table public.code_symbols (
  id bigint generated always as identity primary key,
  file_id uuid not null,
  workspace_id uuid not null,
  user_id uuid not null,
  repository_commit_sha public.git_commit_sha not null,
  ord integer not null check (ord >= 0),
  name text not null check (char_length(name) between 1 and 512),
  kind text not null check (kind in (
    'function', 'method', 'class', 'interface', 'type', 'enum', 'variable', 'constant', 'module'
  )),
  parent_ord integer check (parent_ord >= 0 and parent_ord < ord),
  start_line integer not null check (start_line >= 1),
  start_col integer not null check (start_col >= 1),
  end_line integer not null,
  end_col integer not null check (end_col >= 1),
  exported boolean not null default false,
  signature text check (char_length(signature) <= 512),
  unique (file_id, ord),
  foreign key (file_id, workspace_id, repository_commit_sha, user_id)
    references public.code_files (id, workspace_id, repository_commit_sha, user_id)
    on delete cascade,
  foreign key (file_id, parent_ord)
    references public.code_symbols (file_id, ord)
    on delete cascade,
  check (end_line > start_line or (end_line = start_line and end_col >= start_col))
);

create index code_symbols_name_idx
  on public.code_symbols (workspace_id, repository_commit_sha, lower(name) text_pattern_ops);

-- code_imports --------------------------------------------------------------

create table public.code_imports (
  id bigint generated always as identity primary key,
  file_id uuid not null,
  workspace_id uuid not null,
  user_id uuid not null,
  repository_commit_sha public.git_commit_sha not null,
  ord integer not null check (ord >= 0),
  source text not null check (char_length(source) between 1 and 1024),
  kind text not null check (kind in ('static', 'type', 'dynamic', 'require', 'reexport')),
  names text[] not null default '{}' check (cardinality(names) <= 500),
  resolved_path text check (char_length(resolved_path) between 1 and 1024),
  line integer not null check (line >= 1),
  unique (file_id, ord),
  foreign key (file_id, workspace_id, repository_commit_sha, user_id)
    references public.code_files (id, workspace_id, repository_commit_sha, user_id)
    on delete cascade
);

create index code_imports_source_idx on public.code_imports (workspace_id, repository_commit_sha, source);
create index code_imports_resolved_path_idx on public.code_imports (workspace_id, repository_commit_sha, resolved_path)
  where resolved_path is not null;

-- code_calls ----------------------------------------------------------------

create table public.code_calls (
  id bigint generated always as identity primary key,
  file_id uuid not null,
  workspace_id uuid not null,
  user_id uuid not null,
  repository_commit_sha public.git_commit_sha not null,
  ord integer not null check (ord >= 0),
  caller_ord integer check (caller_ord >= 0),
  callee_text text not null check (char_length(callee_text) between 1 and 256),
  -- Last segment of the callee (`this.db.from` -> `from`), lowercased, for name lookups.
  callee_name text not null generated always as (lower(regexp_replace(callee_text, '^.*[.]', ''))) stored,
  line integer not null check (line >= 1),
  col integer not null check (col >= 1),
  unique (file_id, ord),
  foreign key (file_id, workspace_id, repository_commit_sha, user_id)
    references public.code_files (id, workspace_id, repository_commit_sha, user_id)
    on delete cascade,
  foreign key (file_id, caller_ord)
    references public.code_symbols (file_id, ord)
    on delete cascade
);

create index code_calls_callee_name_idx on public.code_calls (workspace_id, repository_commit_sha, callee_name);

-- RLS -----------------------------------------------------------------------

alter table public.code_files enable row level security;
alter table public.code_symbols enable row level security;
alter table public.code_imports enable row level security;
alter table public.code_calls enable row level security;

revoke all on public.code_files, public.code_symbols, public.code_imports, public.code_calls from anon, authenticated;
grant select on public.code_files, public.code_symbols, public.code_imports, public.code_calls to authenticated;

create policy "Users can read their own code files"
  on public.code_files for select to authenticated
  using (user_id = (select auth.uid()));

create policy "Users can read their own code symbols"
  on public.code_symbols for select to authenticated
  using (user_id = (select auth.uid()));

create policy "Users can read their own code imports"
  on public.code_imports for select to authenticated
  using (user_id = (select auth.uid()));

create policy "Users can read their own code calls"
  on public.code_calls for select to authenticated
  using (user_id = (select auth.uid()));

-- replace_code_index ----------------------------------------------------------
-- Writes one batch of files for one commit. p_files: jsonb array (at most 100) of {
--   path, blob_sha, language?, size_bytes, line_count?, parse_status, parse_error_count?,
--   skipped_reason?, stats?,
--   symbols?: [{name, kind, parent_ord?, start_line, start_col, end_line, end_col, exported?, signature?}],
--   imports?: [{source, kind?, names?, resolved_path?, line}],
--   calls?:   [{caller_ord?, callee_text, line, col}]
-- }
-- Array positions become ord. A file whose payload hash is unchanged is left as is; any other
-- file at the same commit and path is deleted (cascading its facts) and reinserted, so stale facts
-- never survive and identical input always yields identical rows. Other commits are never touched.
-- Returns the number of files written.
-- Errors (message is the code):
--   22023 invalid_code_index_payload  payload is not the shape above
--   22023 duplicate_code_file_path    the batch contains the same path twice
--   P0002 workspace_not_found

create function public.replace_code_index(
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
      file_id, workspace_id, user_id, repository_commit_sha, ord, source, kind, names, resolved_path, line
    )
    select
      v_file_id, v_workspace.id, v_workspace.user_id, v_commit, (i.ord - 1)::integer,
      i.value ->> 'source',
      coalesce(i.value ->> 'kind', 'static'),
      array(select jsonb_array_elements_text(coalesce(i.value -> 'names', '[]'))),
      i.value ->> 'resolved_path',
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

-- prune_code_index ------------------------------------------------------------
-- Deletes every indexed commit of the workspace except p_keep_commits, along with those commits'
-- code_index memory rows. Returns the number of files deleted.
-- Errors: 22023 keep_commits_required (null, empty or containing null).

create function public.prune_code_index(
  p_workspace_id uuid,
  p_keep_commits text[]
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  if p_keep_commits is null or cardinality(p_keep_commits) = 0 or array_position(p_keep_commits, null) is not null then
    raise exception using errcode = '22023', message = 'keep_commits_required';
  end if;

  perform 1 from public.workspaces as w where w.id = p_workspace_id for update;

  delete from public.code_files as c
  where c.workspace_id = p_workspace_id
    and c.repository_commit_sha <> all (p_keep_commits);
  get diagnostics v_deleted = row_count;

  delete from public.repository_memory as m
  where m.workspace_id = p_workspace_id
    and m.kind = 'code_index'
    and m.repository_commit_sha <> all (p_keep_commits);

  return v_deleted;
end;
$$;

-- request_code_index ----------------------------------------------------------
-- Queues a code_indexing job for one analyzed commit. Returns null when the commit has no
-- baseline architecture_summary row, is already indexed with p_parser_version, or a code index is
-- already active for the workspace.

create function public.request_code_index(
  p_workspace_id uuid,
  p_commit_sha text,
  p_parser_version text
)
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
  where w.id = p_workspace_id
  for update;

  if not found then
    return null;
  end if;

  if not exists (
    select 1 from public.repository_memory as m
    where m.workspace_id = p_workspace_id
      and m.repository_commit_sha = p_commit_sha
      and m.kind = 'architecture_summary'
  ) or exists (
    select 1 from public.repository_memory as m
    where m.workspace_id = p_workspace_id
      and m.repository_commit_sha = p_commit_sha
      and m.kind = 'code_index'
      and m.metadata ->> 'parser_version' = p_parser_version
  ) then
    return null;
  end if;

  insert into public.jobs (user_id, workspace_id, type, status, repository_commit_sha)
  values (v_workspace.user_id, p_workspace_id, 'code_indexing', 'queued', p_commit_sha)
  on conflict (workspace_id) where type = 'code_indexing' and status in ('queued', 'running') do nothing
  returning id into v_job_id;

  return v_job_id;
end;
$$;

-- complete_code_index ---------------------------------------------------------
-- Records completeness for the commit in its code_index memory row and marks the job succeeded.
-- p_summary (object, e.g. limits hit and selection caps) is stored as structured with server-side
-- counts under `counts`; the row is replaced on retry.
-- Errors:
--   22023 invalid_code_index_summary
--   P0002 code_index_job_not_found   no code_indexing job with this id for this workspace and commit

create function public.complete_code_index(
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
  on conflict (workspace_id, repository_commit_sha, kind) where kind <> 'file_summary' do update
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

-- fail_code_index -------------------------------------------------------------
-- Marks only the job failed; a succeeded job is never downgraded and the workspace is never
-- touched, since the code index never decides readiness.

create function public.fail_code_index(
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
    and type = 'code_indexing'
    and status <> 'succeeded';
end;
$$;

-- Read functions ----------------------------------------------------------------
-- Security invoker, so RLS applies to authenticated callers. Results are syntactic: matched by
-- name or path, never resolved to declarations.

-- Symbols whose name equals or starts with p_name (case-insensitive), exact matches first.
create function public.find_symbol(
  p_workspace_id uuid,
  p_commit_sha text,
  p_name text,
  p_kind text default null,
  p_limit integer default 20
)
returns table (
  path text,
  language text,
  name text,
  kind text,
  parent_name text,
  start_line integer,
  start_col integer,
  end_line integer,
  end_col integer,
  exported boolean,
  signature text,
  exact boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    f.path, f.language, s.name, s.kind, p.name, s.start_line, s.start_col, s.end_line, s.end_col,
    s.exported, s.signature, lower(s.name) = lower(p_name)
  from public.code_symbols as s
  join public.code_files as f on f.id = s.file_id
  left join public.code_symbols as p on p.file_id = s.file_id and p.ord = s.parent_ord
  where char_length(coalesce(p_name, '')) > 0
    and s.workspace_id = p_workspace_id
    and s.repository_commit_sha = p_commit_sha
    and lower(s.name) like replace(replace(replace(lower(p_name), '\', '\\'), '%', '\%'), '_', '\_') || '%'
    and (p_kind is null or s.kind = p_kind)
  order by lower(s.name) = lower(p_name) desc, s.exported desc, f.path, s.start_line, s.start_col
  limit least(greatest(coalesce(p_limit, 20), 1), 100);
$$;

-- Files importing p_target, matched by path-resolved relative imports or by the specifier as written.
create function public.find_importers(
  p_workspace_id uuid,
  p_commit_sha text,
  p_target text,
  p_limit integer default 50
)
returns table (
  path text,
  source text,
  kind text,
  names text[],
  resolved_path text,
  line integer
)
language sql
stable
security invoker
set search_path = ''
as $$
  select f.path, i.source, i.kind, i.names, i.resolved_path, i.line
  from public.code_imports as i
  join public.code_files as f on f.id = i.file_id
  where i.workspace_id = p_workspace_id
    and i.repository_commit_sha = p_commit_sha
    and (i.resolved_path = p_target or i.source = p_target)
  order by f.path, i.ord
  limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;

-- Imports declared by the file at p_path, in source order.
create function public.find_dependencies(
  p_workspace_id uuid,
  p_commit_sha text,
  p_path text,
  p_limit integer default 100
)
returns table (
  source text,
  kind text,
  names text[],
  resolved_path text,
  line integer
)
language sql
stable
security invoker
set search_path = ''
as $$
  select i.source, i.kind, i.names, i.resolved_path, i.line
  from public.code_files as f
  join public.code_imports as i on i.file_id = f.id
  where f.workspace_id = p_workspace_id
    and f.repository_commit_sha = p_commit_sha
    and f.path = p_path
  order by i.ord
  limit least(greatest(coalesce(p_limit, 100), 1), 500);
$$;

-- Call sites whose callee's last segment matches p_name's last segment; exact callee text first.
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
  exact boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  select f.path, s.name, s.kind, c.callee_text, c.line, c.col, c.callee_text = p_name
  from public.code_calls as c
  join public.code_files as f on f.id = c.file_id
  left join public.code_symbols as s on s.file_id = c.file_id and s.ord = c.caller_ord
  where c.workspace_id = p_workspace_id
    and c.repository_commit_sha = p_commit_sha
    and c.callee_name = lower(regexp_replace(p_name, '^.*[.]', ''))
  order by c.callee_text = p_name desc, f.path, c.line, c.col
  limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;

-- Grants --------------------------------------------------------------------

revoke execute on function public.replace_code_index(uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.replace_code_index(uuid, text, text, jsonb) to service_role;

revoke execute on function public.prune_code_index(uuid, text[]) from public, anon, authenticated;
grant execute on function public.prune_code_index(uuid, text[]) to service_role;

revoke execute on function public.request_code_index(uuid, text, text) from public, anon, authenticated;
grant execute on function public.request_code_index(uuid, text, text) to service_role;

revoke execute on function public.complete_code_index(uuid, uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.complete_code_index(uuid, uuid, text, text, jsonb) to service_role;

revoke execute on function public.fail_code_index(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.fail_code_index(uuid, uuid, text, text) to service_role;

revoke execute on function public.find_symbol(uuid, text, text, text, integer) from public, anon;
grant execute on function public.find_symbol(uuid, text, text, text, integer) to authenticated, service_role;

revoke execute on function public.find_importers(uuid, text, text, integer) from public, anon;
grant execute on function public.find_importers(uuid, text, text, integer) to authenticated, service_role;

revoke execute on function public.find_dependencies(uuid, text, text, integer) from public, anon;
grant execute on function public.find_dependencies(uuid, text, text, integer) to authenticated, service_role;

revoke execute on function public.find_callers(uuid, text, text, integer) from public, anon;
grant execute on function public.find_callers(uuid, text, text, integer) to authenticated, service_role;
