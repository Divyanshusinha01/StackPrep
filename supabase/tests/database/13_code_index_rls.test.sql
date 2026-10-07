begin;

create extension if not exists pgtap with schema extensions;

select plan(31);

-- Fixtures ------------------------------------------------------------------
-- Owner has two workspaces (api, web); other user has one (forked api).

insert into auth.users (id, email) values
  ('13131313-0000-4000-8000-000000000001', 'owner@example.com'),
  ('13131313-0000-4000-8000-000000000002', 'other@example.com');

insert into public.repositories (id, user_id, github_repo_id, owner, name, full_name, is_private, default_branch) values
  ('13131313-0000-4000-8000-000000000011', '13131313-0000-4000-8000-000000000001', 13001, 'owner', 'api', 'owner/api', true, 'main'),
  ('13131313-0000-4000-8000-000000000012', '13131313-0000-4000-8000-000000000001', 13002, 'owner', 'web', 'owner/web', true, 'main'),
  ('13131313-0000-4000-8000-000000000013', '13131313-0000-4000-8000-000000000002', 13003, 'other', 'api', 'other/api', true, 'main');

insert into public.workspaces (id, user_id, repository_id, status, target_commit_sha, indexed_commit_sha, ready_at) values
  ('13131313-0000-4000-8000-000000000021', '13131313-0000-4000-8000-000000000001', '13131313-0000-4000-8000-000000000011', 'ready', repeat('a', 40), repeat('a', 40), now()),
  ('13131313-0000-4000-8000-000000000022', '13131313-0000-4000-8000-000000000001', '13131313-0000-4000-8000-000000000012', 'ready', repeat('a', 40), repeat('a', 40), now()),
  ('13131313-0000-4000-8000-000000000023', '13131313-0000-4000-8000-000000000002', '13131313-0000-4000-8000-000000000013', 'ready', repeat('a', 40), repeat('a', 40), now());

create function pg_temp.file(p_symbol text) returns jsonb language sql as $$
  select jsonb_build_array(jsonb_build_object(
    'path', 'src/index.ts', 'blob_sha', repeat('1', 40), 'language', 'typescript', 'size_bytes', 10, 'parse_status', 'ok',
    'symbols', jsonb_build_array(jsonb_build_object('name', p_symbol, 'kind', 'function', 'start_line', 2, 'start_col', 1, 'end_line', 3, 'end_col', 2)),
    'imports', '[{"source": "./db", "resolved_path": "src/db.ts", "line": 1}]'::jsonb,
    'calls', '[{"caller_ord": 0, "callee_text": "query", "line": 2, "col": 3}]'::jsonb
  ));
$$;

set local role service_role;
select public.replace_code_index('13131313-0000-4000-8000-000000000021', repeat('a', 40), '1', pg_temp.file('apiHandler'));
select public.replace_code_index('13131313-0000-4000-8000-000000000021', repeat('b', 40), '1', pg_temp.file('apiHandlerNext'));
select public.replace_code_index('13131313-0000-4000-8000-000000000022', repeat('a', 40), '1', pg_temp.file('webHandler'));
select public.replace_code_index('13131313-0000-4000-8000-000000000023', repeat('a', 40), '1', pg_temp.file('forkHandler'));
reset role;

create function pg_temp.visible() returns text language sql as $$
  select
    (select count(*) from public.code_files) || '/' ||
    (select count(*) from public.code_symbols) || '/' ||
    (select count(*) from public.code_imports) || '/' ||
    (select count(*) from public.code_calls);
$$;

-- Schema-level guarantees ---------------------------------------------------------------

select ok((select relrowsecurity from pg_class where oid = 'public.code_files'::regclass), 'code_files has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.code_symbols'::regclass), 'code_symbols has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.code_imports'::regclass), 'code_imports has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.code_calls'::regclass), 'code_calls has RLS enabled');

select ok(
  not exists (
    select 1 from information_schema.role_table_grants
    where grantee in ('anon', 'authenticated')
      and table_schema = 'public'
      and table_name in ('code_files', 'code_symbols', 'code_imports', 'code_calls')
      and (grantee = 'anon' or privilege_type <> 'SELECT')
  ),
  'authenticated can only select code index tables and anon has no access'
);

select ok(not has_function_privilege('authenticated', 'public.replace_code_index(uuid, text, text, jsonb)', 'EXECUTE'), 'authenticated cannot execute replace_code_index');
select ok(not has_function_privilege('authenticated', 'public.prune_code_index(uuid, text[])', 'EXECUTE'), 'authenticated cannot execute prune_code_index');
select ok(not has_function_privilege('authenticated', 'public.request_code_index(uuid, text, text)', 'EXECUTE'), 'authenticated cannot execute request_code_index');
select ok(not has_function_privilege('authenticated', 'public.complete_code_index(uuid, uuid, text, text, jsonb)', 'EXECUTE'), 'authenticated cannot execute complete_code_index');
select ok(not has_function_privilege('authenticated', 'public.fail_code_index(uuid, uuid, text, text)', 'EXECUTE'), 'authenticated cannot execute fail_code_index');
select ok(has_function_privilege('service_role', 'public.replace_code_index(uuid, text, text, jsonb)', 'EXECUTE'), 'service_role can execute replace_code_index');
select ok(has_function_privilege('authenticated', 'public.find_symbol(uuid, text, text, text, integer)', 'EXECUTE'), 'authenticated can execute find_symbol');
select ok(not has_function_privilege('anon', 'public.find_symbol(uuid, text, text, text, integer)', 'EXECUTE'), 'anon cannot execute find_symbol');
select ok(not has_function_privilege('anon', 'public.find_callers(uuid, text, text, integer)', 'EXECUTE'), 'anon cannot execute find_callers');

select ok(
  not exists (
    select 1 from pg_proc
    where pronamespace = 'public'::regnamespace
      and proname in ('replace_code_index', 'prune_code_index', 'request_code_index', 'complete_code_index',
                      'fail_code_index', 'find_symbol', 'find_importers', 'find_dependencies', 'find_callers')
      and (prosecdef or not coalesce(proconfig @> array['search_path=""'], false))
  ),
  'code index functions are security invoker with an empty search_path'
);

-- Ownership consistency -------------------------------------------------------------------

select throws_ok(
  $$insert into public.code_files (workspace_id, repository_id, user_id, repository_commit_sha, path, blob_sha, size_bytes, parse_status, skipped_reason, parser_version, facts_hash)
    values ('13131313-0000-4000-8000-000000000021', '13131313-0000-4000-8000-000000000011', '13131313-0000-4000-8000-000000000002',
            repeat('a', 40), 'x.ts', repeat('1', 40), 1, 'skipped', 'binary', '1', md5('x'))$$,
  '23503', null, 'a code file must belong to the workspace owner'
);
select throws_ok(
  $$insert into public.code_symbols (file_id, workspace_id, user_id, repository_commit_sha, ord, name, kind, start_line, start_col, end_line, end_col)
    select id, workspace_id, '13131313-0000-4000-8000-000000000002', repository_commit_sha, 9, 'x', 'function', 1, 1, 1, 2
    from public.code_files where workspace_id = '13131313-0000-4000-8000-000000000021' and repository_commit_sha = repeat('a', 40)$$,
  '23503', null, 'a symbol must carry its file''s owner'
);
select throws_ok(
  $$insert into public.code_symbols (file_id, workspace_id, user_id, repository_commit_sha, ord, name, kind, start_line, start_col, end_line, end_col)
    select id, workspace_id, user_id, repeat('b', 40), 9, 'x', 'function', 1, 1, 1, 2
    from public.code_files where workspace_id = '13131313-0000-4000-8000-000000000021' and repository_commit_sha = repeat('a', 40)$$,
  '23503', null, 'a symbol must carry its file''s commit'
);

-- Owner reads -----------------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "13131313-0000-4000-8000-000000000001", "role": "authenticated"}', true);

select is(pg_temp.visible(), '3/3/3/3', 'the owner sees only their own facts across workspaces and commits');
select is(
  (select coalesce(string_agg(name, ',' order by name), '') from public.find_symbol('13131313-0000-4000-8000-000000000021', repeat('a', 40), 'a')),
  'apiHandler',
  'find_symbol is scoped to one workspace and commit'
);
select is(
  (select coalesce(string_agg(name, ',' order by name), '') from public.find_symbol('13131313-0000-4000-8000-000000000021', repeat('b', 40), 'apiHandler')),
  'apiHandlerNext',
  'another commit of the same workspace returns its own facts'
);
select is(
  (select count(*)::integer from public.find_symbol('13131313-0000-4000-8000-000000000021', repeat('a', 40), 'webHandler')),
  0,
  'symbols from the owner''s other workspace do not leak'
);
select is(
  (select count(*)::integer from public.find_callers('13131313-0000-4000-8000-000000000022', repeat('a', 40), 'query')),
  1,
  'the owner can find callers in their workspace'
);
select throws_ok(
  $$select public.replace_code_index('13131313-0000-4000-8000-000000000021', repeat('a', 40), '1', '[]')$$,
  '42501', null, 'the owner cannot write through replace_code_index'
);
select throws_ok(
  $$delete from public.code_files where workspace_id = '13131313-0000-4000-8000-000000000021'$$,
  '42501', null, 'the owner cannot delete code files directly'
);
select throws_ok(
  $$update public.code_symbols set name = 'hacked'$$,
  '42501', null, 'the owner cannot update symbols directly'
);

-- Other user reads ------------------------------------------------------------------------

select set_config('request.jwt.claims', '{"sub": "13131313-0000-4000-8000-000000000002", "role": "authenticated"}', true);

select is(pg_temp.visible(), '1/1/1/1', 'another user sees only their own facts');
select is(
  (select count(*)::integer from public.find_symbol('13131313-0000-4000-8000-000000000021', repeat('a', 40), 'apiHandler')),
  0,
  'find_symbol respects RLS for another user''s workspace'
);
select is(
  (select count(*)::integer from public.find_importers('13131313-0000-4000-8000-000000000021', repeat('a', 40), 'src/db.ts'))
  + (select count(*)::integer from public.find_dependencies('13131313-0000-4000-8000-000000000021', repeat('a', 40), 'src/index.ts'))
  + (select count(*)::integer from public.find_callers('13131313-0000-4000-8000-000000000021', repeat('a', 40), 'query')),
  0,
  'the import and call lookups respect RLS too'
);
select is(
  (select coalesce(string_agg(name, ','), '') from public.find_symbol('13131313-0000-4000-8000-000000000023', repeat('a', 40), 'fork')),
  'forkHandler',
  'another user can read their own workspace'
);

-- Anonymous -------------------------------------------------------------------------------

reset role;
set local role anon;
select throws_ok($$select count(*) from public.code_files$$, '42501', null, 'anon cannot read code files');

reset role;

select * from finish();
rollback;
