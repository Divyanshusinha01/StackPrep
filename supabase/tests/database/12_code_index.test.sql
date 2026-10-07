begin;

create extension if not exists pgtap with schema extensions;

select plan(50);

-- Fixtures ------------------------------------------------------------------

insert into auth.users (id, email) values
  ('12121212-0000-4000-8000-000000000001', 'noor@example.com');

insert into public.repositories (id, user_id, github_repo_id, owner, name, full_name, is_private, default_branch) values
  ('12121212-0000-4000-8000-000000000003', '12121212-0000-4000-8000-000000000001', 12001, 'noor', 'api', 'noor/api', false, 'main');

insert into public.workspaces (id, user_id, repository_id, status, target_commit_sha, indexed_commit_sha, ready_at) values
  ('12121212-0000-4000-8000-000000000004', '12121212-0000-4000-8000-000000000001', '12121212-0000-4000-8000-000000000003', 'ready', repeat('b', 40), repeat('b', 40), now());

-- Commits a and b have baseline memory; commit c has none.
insert into public.repository_memory (workspace_id, repository_id, user_id, repository_commit_sha, kind, content, structured, metadata) values
  ('12121212-0000-4000-8000-000000000004', '12121212-0000-4000-8000-000000000003', '12121212-0000-4000-8000-000000000001', repeat('a', 40), 'architecture_summary', 'Express API', '{}', '{}'),
  ('12121212-0000-4000-8000-000000000004', '12121212-0000-4000-8000-000000000003', '12121212-0000-4000-8000-000000000001', repeat('b', 40), 'architecture_summary', 'Express API', '{}', '{}');

-- A parsed file with a class, one method named p_method, one import and one call from the method.
create function pg_temp.parsed(p_path text, p_method text) returns jsonb language sql as $$
  select jsonb_build_object(
    'path', p_path,
    'blob_sha', repeat('1', 40),
    'language', 'typescript',
    'size_bytes', 120,
    'line_count', 9,
    'parse_status', 'ok',
    'stats', '{"nodeCount": 40}'::jsonb,
    'symbols', jsonb_build_array(
      jsonb_build_object('name', 'Service', 'kind', 'class', 'start_line', 2, 'start_col', 1, 'end_line', 9, 'end_col', 2,
        'exported', true, 'signature', 'export class Service'),
      jsonb_build_object('name', p_method, 'kind', 'method', 'parent_ord', 0, 'start_line', 3, 'start_col', 3, 'end_line', 5, 'end_col', 4)
    ),
    'imports', jsonb_build_array(
      jsonb_build_object('source', './db', 'names', '["db"]'::jsonb, 'resolved_path', 'src/db.ts', 'line', 1)
    ),
    'calls', jsonb_build_array(
      jsonb_build_object('caller_ord', 1, 'callee_text', 'this.db.from', 'line', 4, 'col', 5)
    )
  );
$$;

create function pg_temp.skipped(p_path text) returns jsonb language sql as $$
  select jsonb_build_object(
    'path', p_path, 'blob_sha', repeat('2', 40), 'size_bytes', 900000,
    'parse_status', 'skipped', 'skipped_reason', 'too_large'
  );
$$;

create function pg_temp.replace(p_sha text, p_files jsonb) returns integer language sql as $$
  select public.replace_code_index('12121212-0000-4000-8000-000000000004', p_sha, '1', p_files);
$$;

create function pg_temp.fact_counts(p_sha text) returns text language sql as $$
  select
    (select count(*) from public.code_files where workspace_id = '12121212-0000-4000-8000-000000000004' and repository_commit_sha = p_sha) || '/' ||
    (select count(*) from public.code_symbols where workspace_id = '12121212-0000-4000-8000-000000000004' and repository_commit_sha = p_sha) || '/' ||
    (select count(*) from public.code_imports where workspace_id = '12121212-0000-4000-8000-000000000004' and repository_commit_sha = p_sha) || '/' ||
    (select count(*) from public.code_calls where workspace_id = '12121212-0000-4000-8000-000000000004' and repository_commit_sha = p_sha);
$$;

create function pg_temp.file_id(p_sha text, p_path text) returns uuid language sql as $$
  select id from public.code_files
  where workspace_id = '12121212-0000-4000-8000-000000000004' and repository_commit_sha = p_sha and path = p_path;
$$;

-- Schema ----------------------------------------------------------------------

select has_table('public', 'code_files', 'code_files exists');
select has_table('public', 'code_symbols', 'code_symbols exists');
select has_table('public', 'code_imports', 'code_imports exists');
select has_table('public', 'code_calls', 'code_calls exists');
select has_index('public', 'jobs', 'jobs_active_code_indexing_key', 'jobs has the active code indexing index');
select ok(
  (select pg_get_constraintdef(oid) like '%''code_indexing''%' from pg_constraint where conname = 'jobs_stage_check'),
  'jobs.stage accepts code_indexing'
);
select ok(
  (select pg_get_constraintdef(oid) like '%''code_index''%' from pg_constraint where conname = 'repository_memory_kind_check'),
  'repository_memory.kind accepts code_index'
);

set local role service_role;

-- replace_code_index: writes ---------------------------------------------------------------

select is(
  pg_temp.replace(repeat('a', 40), jsonb_build_array(pg_temp.parsed('src/service.ts', 'load'), pg_temp.skipped('src/big.ts'))),
  2,
  'both files are written'
);
select is(pg_temp.fact_counts(repeat('a', 40)), '2/2/1/1', 'files, symbols, imports and calls are stored');
select is(
  (select string_agg(ord || ':' || name || ':' || coalesce(parent_ord::text, '-'), ',' order by ord)
   from public.code_symbols where file_id = pg_temp.file_id(repeat('a', 40), 'src/service.ts')),
  '0:Service:-,1:load:0',
  'array positions become ord and parent_ord links the method to its class'
);
select is(
  (select callee_name || ':' || caller_ord from public.code_calls where file_id = pg_temp.file_id(repeat('a', 40), 'src/service.ts')),
  'from:1',
  'callee_name is the lowercased last segment of the callee'
);
select is(
  (select kind || ':' || array_to_string(names, ',') from public.code_imports where file_id = pg_temp.file_id(repeat('a', 40), 'src/service.ts')),
  'static:db',
  'import kind defaults to static and names are kept'
);
select is(
  (select parse_status || ':' || skipped_reason || ':' || coalesce(language, '-') from public.code_files
   where id = pg_temp.file_id(repeat('a', 40), 'src/big.ts')),
  'skipped:too_large:-',
  'skipped files are recorded with their reason'
);
select is(
  (select user_id::text || ':' || repository_id::text from public.code_files where id = pg_temp.file_id(repeat('a', 40), 'src/service.ts')),
  '12121212-0000-4000-8000-000000000001:12121212-0000-4000-8000-000000000003',
  'ownership is copied from the workspace'
);

-- replace_code_index: idempotency and stale replacement --------------------------------------

create temp table before_ids as
  select s.id as symbol_id, f.id as file_id
  from public.code_files as f left join public.code_symbols as s on s.file_id = f.id
  where f.workspace_id = '12121212-0000-4000-8000-000000000004' and f.repository_commit_sha = repeat('a', 40);

select is(
  pg_temp.replace(repeat('a', 40), jsonb_build_array(pg_temp.parsed('src/service.ts', 'load'), pg_temp.skipped('src/big.ts'))),
  0,
  're-indexing identical facts writes nothing'
);
select is(
  (select count(*)::integer from before_ids where symbol_id in (select id from public.code_symbols)),
  2,
  'identical facts keep the existing rows'
);

select is(
  pg_temp.replace(repeat('a', 40), jsonb_build_array(pg_temp.parsed('src/service.ts', 'save'))),
  1,
  'changed facts rewrite only the changed file'
);
select is(pg_temp.fact_counts(repeat('a', 40)), '2/2/1/1', 'stale facts are replaced, not appended');
select is(
  (select string_agg(name, ',' order by ord) from public.code_symbols where file_id = pg_temp.file_id(repeat('a', 40), 'src/service.ts')),
  'Service,save',
  'the old method is gone'
);
select ok(
  pg_temp.file_id(repeat('a', 40), 'src/service.ts') not in (select file_id from before_ids),
  'a changed file gets a new row'
);
select ok(
  pg_temp.file_id(repeat('a', 40), 'src/big.ts') in (select file_id from before_ids),
  'files missing from a batch are left alone'
);

-- Commit isolation --------------------------------------------------------------------------

select is(
  pg_temp.replace(repeat('b', 40), jsonb_build_array(pg_temp.parsed('src/service.ts', 'load'))),
  1,
  'the same path is indexed separately for another commit'
);
select is(pg_temp.fact_counts(repeat('a', 40)) || '|' || pg_temp.fact_counts(repeat('b', 40)), '2/2/1/1|1/2/1/1', 'commits do not share rows');
select is(
  (select string_agg(name, ',' order by ord) from public.code_symbols where file_id = pg_temp.file_id(repeat('a', 40), 'src/service.ts')),
  'Service,save',
  'indexing commit b leaves commit a untouched'
);

-- replace_code_index: validation -----------------------------------------------------------

select throws_ok(
  $$select pg_temp.replace(repeat('a', 40), '{}')$$,
  '22023', 'invalid_code_index_payload', 'the batch must be an array'
);
select throws_ok(
  $$select pg_temp.replace(repeat('a', 40), jsonb_build_array(jsonb_build_object('path', 'x.ts')))$$,
  '22023', 'invalid_code_index_payload', 'each file needs path, blob_sha and parse_status'
);
select throws_ok(
  $$select pg_temp.replace(repeat('a', 40), (select jsonb_agg(pg_temp.skipped('f' || g || '.ts')) from generate_series(1, 101) as g))$$,
  '22023', 'invalid_code_index_payload', 'a batch holds at most 100 files'
);
select throws_ok(
  $$select pg_temp.replace(repeat('a', 40), jsonb_build_array(pg_temp.skipped('x.ts'), pg_temp.skipped('x.ts')))$$,
  '22023', 'duplicate_code_file_path', 'a batch cannot repeat a path'
);
select throws_ok(
  $$select public.replace_code_index('12121212-0000-4000-8000-0000000000ff', repeat('a', 40), '1', '[]')$$,
  'P0002', 'workspace_not_found', 'the workspace must exist'
);
select throws_ok(
  $$select pg_temp.replace(repeat('a', 40), jsonb_build_array(pg_temp.parsed('src/new.ts', 'x') || jsonb_build_object(
    'symbols', '[{"name": "x", "kind": "method", "parent_ord": 0, "start_line": 1, "start_col": 1, "end_line": 1, "end_col": 2}]'::jsonb)))$$,
  '23514', null, 'a symbol cannot be its own parent'
);
select throws_ok(
  $$select pg_temp.replace(repeat('a', 40), jsonb_build_array(pg_temp.parsed('src/new.ts', 'x') || jsonb_build_object(
    'calls', '[{"caller_ord": 7, "callee_text": "f", "line": 1, "col": 1}]'::jsonb)))$$,
  '23503', null, 'a call cannot point at a missing symbol'
);
select throws_ok(
  $$select pg_temp.replace(repeat('a', 40), jsonb_build_array(pg_temp.skipped('src/new.ts') - 'skipped_reason'))$$,
  '23514', null, 'a skipped file needs a reason'
);
select is(pg_temp.file_id(repeat('a', 40), 'src/new.ts'), null, 'a rejected batch writes nothing');

-- Read functions ----------------------------------------------------------------------------

select is(
  (select string_agg(path || ':' || name || ':' || kind || ':' || coalesce(parent_name, '-') || ':' || exact, ',')
   from public.find_symbol('12121212-0000-4000-8000-000000000004', repeat('a', 40), 'sav')),
  'src/service.ts:save:method:Service:false',
  'find_symbol matches a prefix and returns the parent name'
);
select is(
  (select count(*)::integer from public.find_symbol('12121212-0000-4000-8000-000000000004', repeat('a', 40), '%')),
  0,
  'find_symbol treats LIKE wildcards literally'
);
select is(
  (select string_agg(path || ':' || source, ',')
   from public.find_importers('12121212-0000-4000-8000-000000000004', repeat('a', 40), 'src/db.ts')),
  'src/service.ts:./db',
  'find_importers matches the resolved path'
);
select is(
  (select string_agg(source || ':' || line, ',')
   from public.find_dependencies('12121212-0000-4000-8000-000000000004', repeat('a', 40), 'src/service.ts')),
  './db:1',
  'find_dependencies lists a file''s imports'
);
select is(
  (select string_agg(path || ':' || caller_name || ':' || exact, ',')
   from public.find_callers('12121212-0000-4000-8000-000000000004', repeat('a', 40), 'Repo.from')),
  'src/service.ts:save:false',
  'find_callers matches the last segment and reports the enclosing symbol'
);

-- Jobs --------------------------------------------------------------------------------------

select is(
  public.request_code_index('12121212-0000-4000-8000-000000000004', repeat('c', 40), '1'),
  null,
  'a commit without baseline memory gets no job'
);
create temp table first_job as select public.request_code_index('12121212-0000-4000-8000-000000000004', repeat('a', 40), '1') as id;
select is(
  public.request_code_index('12121212-0000-4000-8000-000000000004', repeat('b', 40), '1'),
  null,
  'only one code index runs per workspace'
);
select throws_ok(
  $$select public.complete_code_index('12121212-0000-4000-8000-000000000004', (select id from first_job), repeat('b', 40), '1', '{}')$$,
  'P0002', 'code_index_job_not_found', 'a job cannot complete another commit'
);
select throws_ok(
  $$select public.complete_code_index('12121212-0000-4000-8000-000000000004', (select id from first_job), repeat('a', 40), '1', '[]')$$,
  '22023', 'invalid_code_index_summary', 'the summary must be an object'
);
select public.complete_code_index('12121212-0000-4000-8000-000000000004', (select id from first_job), repeat('a', 40), '1', '{"limits_hit": []}');
select is(
  (select content || '|' || (structured #>> '{counts,files}') || '|' || (structured #>> '{counts,skipped}') || '|' ||
          (structured #>> '{counts,symbols}') || '|' || (structured #>> '{counts,languages,typescript}') || '|' || (metadata ->> 'parser_version')
   from public.repository_memory
   where workspace_id = '12121212-0000-4000-8000-000000000004' and repository_commit_sha = repeat('a', 40) and kind = 'code_index'),
  '|2|1|2|1|1',
  'completion stores server-side counts in an empty-content code_index row'
);
select is(
  (select status::text from public.jobs where id = (select id from first_job)),
  'succeeded',
  'completion marks the job succeeded'
);
select is(
  public.request_code_index('12121212-0000-4000-8000-000000000004', repeat('a', 40), '1'),
  null,
  'a commit indexed with the same parser version gets no job'
);
create temp table second_job as select public.request_code_index('12121212-0000-4000-8000-000000000004', repeat('a', 40), '2') as id;
select public.fail_code_index('12121212-0000-4000-8000-000000000004', (select id from first_job), 'internal_error', 'late');
select public.fail_code_index('12121212-0000-4000-8000-000000000004', (select id from second_job), 'internal_error', 'boom');
select is(
  (select status::text from public.jobs where id = (select id from first_job)) || ',' ||
  (select status::text from public.jobs where id = (select id from second_job)),
  'succeeded,failed',
  'a new parser version re-indexes, and failure never downgrades a succeeded job'
);

-- prune_code_index --------------------------------------------------------------------------

select throws_ok(
  $$select public.prune_code_index('12121212-0000-4000-8000-000000000004', '{}')$$,
  '22023', 'keep_commits_required', 'prune needs commits to keep'
);
select is(
  public.prune_code_index('12121212-0000-4000-8000-000000000004', array[repeat('b', 40)]),
  2,
  'prune reports the deleted files'
);
select is(
  pg_temp.fact_counts(repeat('a', 40)) || '|' || pg_temp.fact_counts(repeat('b', 40)) || '|' ||
  (select count(*) from public.repository_memory where workspace_id = '12121212-0000-4000-8000-000000000004' and kind = 'code_index'),
  '0/0/0/0|1/2/1/1|0',
  'prune removes other commits, their facts and their code_index row'
);

reset role;

delete from public.workspaces where id = '12121212-0000-4000-8000-000000000004';
select is(pg_temp.fact_counts(repeat('b', 40)), '0/0/0/0', 'deleting the workspace cascades to the code index');

select * from finish();
rollback;
