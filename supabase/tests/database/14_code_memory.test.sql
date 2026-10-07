begin;

create extension if not exists pgtap with schema extensions;

select plan(34);

-- Fixtures ------------------------------------------------------------------

insert into auth.users (id, email) values
  ('14141414-0000-4000-8000-000000000001', 'ines@example.com'),
  ('14141414-0000-4000-8000-000000000002', 'otto@example.com');

insert into public.repositories (id, user_id, github_repo_id, owner, name, full_name, is_private, default_branch) values
  ('14141414-0000-4000-8000-000000000003', '14141414-0000-4000-8000-000000000001', 14001, 'ines', 'api', 'ines/api', true, 'main');

insert into public.workspaces (id, user_id, repository_id, status, target_commit_sha, indexed_commit_sha, ready_at) values
  ('14141414-0000-4000-8000-000000000004', '14141414-0000-4000-8000-000000000001', '14141414-0000-4000-8000-000000000003', 'ready', repeat('a', 40), repeat('a', 40), now());

-- Baseline memory of commit a, including a baseline file_summary that code memory must never touch.
insert into public.repository_memory (workspace_id, repository_id, user_id, repository_commit_sha, kind, content, structured, metadata) values
  ('14141414-0000-4000-8000-000000000004', '14141414-0000-4000-8000-000000000003', '14141414-0000-4000-8000-000000000001', repeat('a', 40), 'architecture_summary', 'Express API', '{}', '{}'),
  ('14141414-0000-4000-8000-000000000004', '14141414-0000-4000-8000-000000000003', '14141414-0000-4000-8000-000000000001', repeat('a', 40), 'file_summary', 'baseline summary', '{"path": "src/a.ts"}', '{}');

create function pg_temp.job_id() returns uuid language sql as $$
  select id from public.jobs where workspace_id = '14141414-0000-4000-8000-000000000004' and type = 'code_indexing';
$$;

create function pg_temp.save(p_rows jsonb, p_sha text default repeat('a', 40)) returns integer language sql as $$
  select public.save_code_memory('14141414-0000-4000-8000-000000000004', pg_temp.job_id(), p_sha, p_rows);
$$;

create function pg_temp.mem(p_kind text, p_path text, p_content text) returns jsonb language sql as $$
  select jsonb_build_object('kind', p_kind, 'content', p_content, 'structured', jsonb_build_object('path', p_path),
    'metadata', '{"parser_version": "1"}'::jsonb, 'token_count', 3);
$$;

create function pg_temp.code_rows() returns text language sql as $$
  select coalesce(string_agg(kind || ':' || (structured ->> 'path'), ',' order by created_at, kind), '')
  from public.repository_memory
  where workspace_id = '14141414-0000-4000-8000-000000000004' and metadata ->> 'source' = 'code_index';
$$;

-- Schema ----------------------------------------------------------------------

select ok(
  (select pg_get_constraintdef(oid) like '%''code_module''%' from pg_constraint where conname = 'repository_memory_kind_check'),
  'repository_memory.kind accepts code_module'
);
select ok(
  (select indexdef like '%code_module%' from pg_indexes where indexname = 'repository_memory_workspace_commit_kind_key'),
  'code_module rows are not limited to one per commit'
);
select ok(not has_function_privilege('authenticated', 'public.save_code_memory(uuid, uuid, text, jsonb)', 'EXECUTE'), 'authenticated cannot execute save_code_memory');
select ok(has_function_privilege('service_role', 'public.save_code_memory(uuid, uuid, text, jsonb)', 'EXECUTE'), 'service_role can execute save_code_memory');
select ok(has_function_privilege('authenticated', 'public.search_code_symbols(uuid, text, text[], integer)', 'EXECUTE'), 'authenticated can execute search_code_symbols');
select ok(not has_function_privilege('anon', 'public.search_code_symbols(uuid, text, text[], integer)', 'EXECUTE'), 'anon cannot execute search_code_symbols');
select ok(
  not exists (
    select 1 from pg_proc
    where pronamespace = 'public'::regnamespace
      and proname in ('save_code_memory', 'search_code_symbols', 'record_evidence_examined')
      and (prosecdef or not coalesce(proconfig @> array['search_path=""'], false))
  ),
  'the new functions are security invoker with an empty search_path'
);

set local role service_role;

select isnt(public.request_code_index('14141414-0000-4000-8000-000000000004', repeat('a', 40), '1'), null, 'a code index job is queued for commit a');

-- save_code_memory ------------------------------------------------------------------

select is(
  pg_temp.save(jsonb_build_array(
    pg_temp.mem('code_module', 'src/', 'Module src/'),
    pg_temp.mem('code_module', 'lib/', 'Module lib/'),
    pg_temp.mem('file_summary', 'src/a.ts', 'src/a.ts outline')
  )),
  3,
  'code memory rows are inserted'
);
select is(pg_temp.code_rows(), 'code_module:src/,code_module:lib/,file_summary:src/a.ts', 'rows keep the given order through created_at and are tagged as code_index');

create temp table first_ids as
  select id from public.repository_memory where metadata ->> 'source' = 'code_index';

select is(
  pg_temp.save(jsonb_build_array(
    pg_temp.mem('code_module', 'src/', 'Module src/'),
    pg_temp.mem('code_module', 'lib/', 'Module lib/'),
    pg_temp.mem('file_summary', 'src/a.ts', 'src/a.ts outline')
  )),
  0,
  'saving identical rows inserts nothing'
);
select is(
  (select count(*)::integer from first_ids where id in (select id from public.repository_memory)),
  3,
  'identical rows keep their ids, and so their embeddings'
);

select is(
  pg_temp.save(jsonb_build_array(
    pg_temp.mem('code_module', 'src/', 'Module src/'),
    pg_temp.mem('file_summary', 'src/a.ts', 'src/a.ts new outline')
  )),
  1,
  'only the changed row is inserted'
);
select is(pg_temp.code_rows(), 'code_module:src/,file_summary:src/a.ts', 'changed and omitted rows are replaced, not appended');
select is(
  (select content from public.repository_memory where metadata ->> 'source' = 'code_index' and kind = 'file_summary'),
  'src/a.ts new outline',
  'the file summary carries the new content'
);
select is(
  (select count(*)::integer from public.repository_memory
   where workspace_id = '14141414-0000-4000-8000-000000000004' and kind = 'file_summary' and content = 'baseline summary'),
  1,
  'baseline file summaries are never touched'
);

select throws_ok($$select pg_temp.save(jsonb_build_array(pg_temp.mem('concepts', 'src/', 'x')))$$, '22023', 'invalid_code_memory_payload', 'only code_module and file_summary rows are accepted');
select throws_ok($$select pg_temp.save(jsonb_build_array(pg_temp.mem('code_module', 'src/', '')))$$, '22023', 'invalid_code_memory_payload', 'empty content is rejected');
select throws_ok($$select pg_temp.save('{}')$$, '22023', 'invalid_code_memory_payload', 'a non-array payload is rejected');
select throws_ok(
  $$select pg_temp.save(jsonb_build_array(pg_temp.mem('code_module', 'src/', 'a'), pg_temp.mem('code_module', 'src/', 'b')))$$,
  '22023', 'duplicate_code_memory_path', 'the same kind and path twice is rejected'
);
select throws_ok(
  $$select pg_temp.save(jsonb_build_array(pg_temp.mem('code_module', 'src/', 'a')), repeat('c', 40))$$,
  'P0002', 'code_index_job_not_found', 'a job for another commit cannot write memory'
);

select lives_ok(
  $$select public.complete_code_index('14141414-0000-4000-8000-000000000004', pg_temp.job_id(), repeat('a', 40), '1', '{}');
    select public.complete_code_index('14141414-0000-4000-8000-000000000004', pg_temp.job_id(), repeat('a', 40), '1', '{}')$$,
  'complete_code_index still upserts its row under the new index predicate'
);
select is(
  (select count(*)::integer from public.repository_memory where workspace_id = '14141414-0000-4000-8000-000000000004' and kind = 'code_index'),
  1,
  'there is one code_index row per commit'
);

-- search_code_symbols ---------------------------------------------------------------

select public.replace_code_index('14141414-0000-4000-8000-000000000004', repeat('a', 40), '1', jsonb_build_array(jsonb_build_object(
  'path', 'src/users.ts', 'blob_sha', repeat('1', 40), 'language', 'typescript', 'size_bytes', 100, 'parse_status', 'ok',
  'symbols', jsonb_build_array(
    jsonb_build_object('name', 'UserService', 'kind', 'class', 'start_line', 1, 'start_col', 1, 'end_line', 9, 'end_col', 2, 'exported', true),
    jsonb_build_object('name', 'loadUser', 'kind', 'method', 'parent_ord', 0, 'start_line', 2, 'start_col', 3, 'end_line', 4, 'end_col', 4),
    jsonb_build_object('name', 'helper', 'kind', 'function', 'start_line', 11, 'start_col', 1, 'end_line', 12, 'end_col', 2)
  )
)));

select is(
  (select string_agg(name, ',' order by ordinality) from public.search_code_symbols('14141414-0000-4000-8000-000000000004', repeat('a', 40), array['user']) with ordinality),
  'UserService,loadUser',
  'symbols containing a term match, exported first'
);
select is(
  (select name || ':' || matched_terms || ':' || parent_name || ':' || start_line || '-' || end_line
   from public.search_code_symbols('14141414-0000-4000-8000-000000000004', repeat('a', 40), array['load', 'USER']) limit 1),
  'loadUser:2:UserService:2-4',
  'more matched terms rank first; the parent and line range are returned'
);
select is(
  (select count(*)::integer from public.search_code_symbols('14141414-0000-4000-8000-000000000004', repeat('a', 40), array['x'])),
  0,
  'single-character terms are ignored'
);
select is(
  (select count(*)::integer from public.search_code_symbols('14141414-0000-4000-8000-000000000004', repeat('b', 40), array['user'])),
  0,
  'another commit has its own (empty) index'
);

reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "14141414-0000-4000-8000-000000000001", "role": "authenticated"}', true);
select is(
  (select count(*)::integer from public.search_code_symbols('14141414-0000-4000-8000-000000000004', repeat('a', 40), array['user'])),
  2,
  'the owner can search their symbols'
);
select set_config('request.jwt.claims', '{"sub": "14141414-0000-4000-8000-000000000002", "role": "authenticated"}', true);
select is(
  (select count(*)::integer from public.search_code_symbols('14141414-0000-4000-8000-000000000004', repeat('a', 40), array['user'])),
  0,
  'another user finds nothing in the workspace'
);
reset role;

-- record_evidence_examined -------------------------------------------------------------

set local role service_role;
select lives_ok(
  $$select * from public.create_interview(
      '14141414-0000-4000-8000-000000000004', '14141414-0000-4000-8000-000000000001', repeat('a', 40), '{}', '{}', '{}')$$,
  'fixture interview is created'
);

create function pg_temp.interview_id() returns uuid language sql as $$
  select id from public.interviews where workspace_id = '14141414-0000-4000-8000-000000000004';
$$;

create function pg_temp.evidence(p_path text) returns jsonb language sql as $$
  select payload from public.interview_events
  where interview_id = pg_temp.interview_id() and event_type = 'evidence_examined' and payload ->> 'path' = p_path;
$$;

select is(
  public.record_evidence_examined(pg_temp.interview_id(), '14141414-0000-4000-8000-000000000001', jsonb_build_array(
    jsonb_build_object('path', 'src/users.ts', 'area', 'src', 'tool', 'get_file', 'symbol', 'UserService.loadUser',
      'startLine', 2, 'endLine', 4, 'commit_sha', repeat('a', 40)),
    jsonb_build_object('path', 'src/bad.ts', 'tool', 'search_repository', 'symbol', 5, 'startLine', 0, 'endLine', 1.5,
      'commit_sha', 'not-a-sha'),
    jsonb_build_object('path', 'src/plain.ts', 'tool', 'get_file')
  )),
  3,
  'evidence with and without symbol fields is recorded'
);
select is(
  pg_temp.evidence('src/users.ts'),
  jsonb_build_object('path', 'src/users.ts', 'area', 'src', 'tool', 'get_file', 'symbol', 'UserService.loadUser',
    'startLine', 2, 'endLine', 4, 'commit_sha', repeat('a', 40)),
  'the symbol, line range and commit are kept'
);
select is(
  pg_temp.evidence('src/bad.ts'),
  '{"path": "src/bad.ts", "tool": "search_repository"}'::jsonb,
  'malformed symbol fields are dropped one by one'
);
select is(
  pg_temp.evidence('src/plain.ts'),
  '{"path": "src/plain.ts", "tool": "get_file"}'::jsonb,
  'the original {path, area, tool} payload still works'
);

reset role;

select * from finish();
rollback;
