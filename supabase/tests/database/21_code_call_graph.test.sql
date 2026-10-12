begin;

create extension if not exists pgtap with schema extensions;

select plan(38);

-- Fixtures ------------------------------------------------------------------

insert into auth.users (id, email) values
  ('21212121-0000-4000-8000-000000000001', 'graph@example.com');

insert into public.repositories (id, user_id, github_repo_id, owner, name, full_name, is_private, default_branch) values
  ('21212121-0000-4000-8000-000000000003', '21212121-0000-4000-8000-000000000001', 21001, 'graph', 'app', 'graph/app', false, 'main');

insert into public.workspaces (id, user_id, repository_id, status, target_commit_sha, indexed_commit_sha, ready_at) values
  ('21212121-0000-4000-8000-000000000004', '21212121-0000-4000-8000-000000000001', '21212121-0000-4000-8000-000000000003', 'ready', repeat('a', 40), repeat('a', 40), now());

create function pg_temp.sym(p_name text, p_kind text, p_parent integer, p_line integer, p_signature text default null) returns jsonb language sql as $$
  select jsonb_build_object('name', p_name, 'kind', p_kind, 'parent_ord', p_parent, 'start_line', p_line, 'start_col', 1,
    'end_line', p_line + 1, 'end_col', 2, 'exported', p_parent is null, 'signature', p_signature);
$$;

create function pg_temp.call(p_caller integer, p_callee text, p_line integer) returns jsonb language sql as $$
  select jsonb_build_object('caller_ord', p_caller, 'callee_text', p_callee, 'line', p_line, 'col', 5);
$$;

create function pg_temp.file(p_path text, p_symbols jsonb, p_calls jsonb, p_imports jsonb default '[]', p_language text default 'typescript') returns jsonb language sql as $$
  select jsonb_build_object('path', p_path, 'blob_sha', repeat('1', 40), 'language', p_language, 'size_bytes', 100,
    'line_count', 20, 'parse_status', 'ok', 'symbols', p_symbols, 'calls', p_calls, 'imports', p_imports);
$$;

create function pg_temp.index(p_files jsonb) returns integer language sql as $$
  select public.replace_code_index('21212121-0000-4000-8000-000000000004', repeat('a', 40), '2', p_files);
$$;

create function pg_temp.edges(p_files jsonb) returns integer language sql as $$
  select public.replace_code_edges('21212121-0000-4000-8000-000000000004', repeat('a', 40), p_files);
$$;

create function pg_temp.edge(p_call integer, p_target text, p_ord integer, p_confidence text default 'resolved', p_count integer default 1) returns jsonb language sql as $$
  select jsonb_build_object('call_ord', p_call, 'target_path', p_target, 'target_ord', p_ord, 'confidence', p_confidence, 'candidate_count', p_count);
$$;

-- Every stored edge as source:call->target:ord:confidence:count.
create function pg_temp.stored() returns text language sql as $$
  select coalesce(string_agg(s.path || ':' || e.call_ord || '->' || t.path || ':' || e.target_ord || ':' || e.confidence || ':' || e.candidate_count,
    ',' order by s.path, e.call_ord, t.path, e.target_ord), '')
  from public.code_call_edges as e
  join public.code_files as s on s.id = e.file_id
  join public.code_files as t on t.id = e.target_file_id
  where e.workspace_id = '21212121-0000-4000-8000-000000000004';
$$;

-- find_callers rows in result order as path:line:resolved:confidence:target.
create function pg_temp.callers(p_name text, p_limit integer default 50, p_file text default null, p_symbol text default null) returns text language sql as $$
  select coalesce(string_agg(r.path || ':' || r.line || ':' || r.resolved || ':' || coalesce(r.confidence, '-') || ':' ||
    coalesce(r.target_path || '#' || r.target_name, '-'), ',' order by r.n), '')
  from public.find_callers('21212121-0000-4000-8000-000000000004', repeat('a', 40), p_name, p_limit, p_file, p_symbol)
    with ordinality as r(path, caller_name, caller_kind, callee_text, line, col, exact, resolved, confidence, target_path, target_name, n);
$$;

set local role service_role;

-- repo.ts: class Repo { find() } and a top-level find(); other.ts: find() calling find();
-- service.ts: Service.load() calling this.repo.find, find, helper and ns::find.
select pg_temp.index(jsonb_build_array(
  pg_temp.file('src/repo.ts', jsonb_build_array(pg_temp.sym('Repo', 'class', null, 1), pg_temp.sym('find', 'method', 0, 2), pg_temp.sym('find', 'function', null, 8)), '[]'),
  pg_temp.file('src/other.ts', jsonb_build_array(pg_temp.sym('find', 'function', null, 1)), jsonb_build_array(pg_temp.call(null, 'find', 2))),
  pg_temp.file('src/service.ts',
    jsonb_build_array(pg_temp.sym('Service', 'class', null, 2), pg_temp.sym('load', 'method', 0, 3)),
    jsonb_build_array(pg_temp.call(1, 'this.repo.find', 4), pg_temp.call(1, 'find', 5), pg_temp.call(1, 'helper', 6), pg_temp.call(1, 'ns::find', 7)),
    '[{"source": "./repo", "names": ["Repo"], "resolved_path": "src/repo.ts", "resolution": "resolved", "line": 1}]'),
  pg_temp.file('src/store.cc', jsonb_build_array(pg_temp.sym('make', 'function', null, 3, 'void Store::make()')), '[]', '[]', 'cpp'),
  pg_temp.file('src/main.cc', jsonb_build_array(pg_temp.sym('main', 'function', null, 1, 'int main()')), jsonb_build_array(pg_temp.call(0, 'Store::make', 3)), '[]', 'cpp'),
  jsonb_build_object('path', 'src/big.ts', 'blob_sha', repeat('2', 40), 'size_bytes', 900000, 'parse_status', 'skipped', 'skipped_reason', 'too_large')
));

-- Schema ----------------------------------------------------------------------

select has_table('public', 'code_call_edges', 'code_call_edges exists');
select has_index('public', 'code_call_edges', 'code_call_edges_target_idx', 'edges are indexed by target');

-- replace_code_edges: writes ------------------------------------------------------

select is(
  pg_temp.edges(jsonb_build_array(
    jsonb_build_object('path', 'src/service.ts', 'edges', jsonb_build_array(
      pg_temp.edge(0, 'src/repo.ts', 1),
      pg_temp.edge(1, 'src/repo.ts', 2, 'ambiguous', 3),
      pg_temp.edge(1, 'src/other.ts', 0, 'ambiguous', 3))),
    jsonb_build_object('path', 'src/main.cc', 'edges', jsonb_build_array(pg_temp.edge(0, 'src/store.cc', 0))),
    jsonb_build_object('path', 'src/other.ts', 'edges', '[]'::jsonb)
  )),
  4,
  'replace_code_edges returns the number of edges written'
);
select is(
  pg_temp.stored(),
  'src/main.cc:0->src/store.cc:0:resolved:1,src/service.ts:0->src/repo.ts:1:resolved:1,src/service.ts:1->src/other.ts:0:ambiguous:3,src/service.ts:1->src/repo.ts:2:ambiguous:3',
  'resolved and ambiguous edges are stored against call and symbol ordinals'
);
select is(
  (select string_agg(distinct user_id::text || ':' || repository_commit_sha, ',') from public.code_call_edges where workspace_id = '21212121-0000-4000-8000-000000000004'),
  '21212121-0000-4000-8000-000000000001:' || repeat('a', 40),
  'ownership and commit are copied from the workspace'
);

create temp table edges_before as select pg_temp.stored() as v;
select is(
  pg_temp.edges(jsonb_build_array(jsonb_build_object('path', 'src/service.ts', 'edges', jsonb_build_array(
    pg_temp.edge(0, 'src/repo.ts', 1), pg_temp.edge(1, 'src/repo.ts', 2, 'ambiguous', 3), pg_temp.edge(1, 'src/other.ts', 0, 'ambiguous', 3))))),
  3,
  'replaying a file''s edges writes them again'
);
select is(pg_temp.stored(), (select v from edges_before), 'the same input yields the same edges');

select is(pg_temp.edges('[{"path": "src/main.cc", "edges": []}]'), 0, 'a listed file with no edges writes nothing');
select is(
  pg_temp.stored(),
  'src/service.ts:0->src/repo.ts:1:resolved:1,src/service.ts:1->src/other.ts:0:ambiguous:3,src/service.ts:1->src/repo.ts:2:ambiguous:3',
  'a listed file with no edges has its edges cleared and unlisted files are untouched'
);
select pg_temp.edges(jsonb_build_array(jsonb_build_object('path', 'src/main.cc', 'edges', jsonb_build_array(pg_temp.edge(0, 'src/store.cc', 0)))));

-- replace_code_edges: validation ---------------------------------------------------

select throws_ok($$select pg_temp.edges('{}')$$, '22023', 'invalid_code_edges_payload', 'the batch must be an array');
select throws_ok(
  $$select pg_temp.edges((select jsonb_agg(jsonb_build_object('path', 'f' || g)) from generate_series(1, 101) as g))$$,
  '22023', 'invalid_code_edges_payload', 'a batch holds at most 100 files'
);
select throws_ok(
  $$select pg_temp.edges('[{"path": "src/service.ts", "edges": [{"call_ord": 0, "target_path": "src/repo.ts", "confidence": "resolved", "candidate_count": 1}]}]')$$,
  '22023', 'invalid_code_edges_payload', 'each edge needs every field'
);
select throws_ok(
  $$select pg_temp.edges(jsonb_build_array(jsonb_build_object('path', 'src/service.ts', 'edges',
    (select jsonb_agg(pg_temp.edge(0, 'src/repo.ts', 1)) from generate_series(1, 20001)))))$$,
  '22023', 'invalid_code_edges_payload', 'a batch holds at most 20000 edges'
);
select throws_ok(
  $$select pg_temp.edges('[{"path": "src/main.cc"}, {"path": "src/main.cc"}]')$$,
  '22023', 'duplicate_code_file_path', 'a batch cannot repeat a source path'
);
select throws_ok(
  $$select public.replace_code_edges('21212121-0000-4000-8000-0000000000ff', repeat('a', 40), '[]')$$,
  'P0002', 'workspace_not_found', 'the workspace must exist'
);
select throws_ok(
  $$select pg_temp.edges('[{"path": "src/missing.ts", "edges": []}]')$$,
  'P0002', 'code_file_not_found', 'the source file must be indexed at the commit'
);
select throws_ok(
  $$select pg_temp.edges(jsonb_build_array(jsonb_build_object('path', 'src/main.cc', 'edges', jsonb_build_array(pg_temp.edge(0, 'src/missing.ts', 0)))))$$,
  'P0002', 'code_file_not_found', 'the target file must be indexed at the commit'
);
select throws_ok(
  $$select pg_temp.edges(jsonb_build_array(jsonb_build_object('path', 'src/main.cc', 'edges', jsonb_build_array(pg_temp.edge(9, 'src/store.cc', 0)))))$$,
  '23503', null, 'an edge needs an existing call'
);
select throws_ok(
  $$select pg_temp.edges(jsonb_build_array(jsonb_build_object('path', 'src/main.cc', 'edges', jsonb_build_array(pg_temp.edge(0, 'src/store.cc', 9)))))$$,
  '23503', null, 'an edge needs an existing target symbol'
);
select throws_ok(
  $$select pg_temp.edges(jsonb_build_array(jsonb_build_object('path', 'src/main.cc', 'edges', jsonb_build_array(pg_temp.edge(0, 'src/store.cc', 0, 'resolved', 2)))))$$,
  '23514', null, 'a resolved edge has exactly one candidate'
);
select throws_ok(
  $$select pg_temp.edges(jsonb_build_array(jsonb_build_object('path', 'src/main.cc', 'edges', jsonb_build_array(pg_temp.edge(0, 'src/store.cc', 0, 'unresolved', 1)))))$$,
  '23514', null, 'unresolved calls are never stored as edges'
);
select is(
  pg_temp.stored(),
  'src/main.cc:0->src/store.cc:0:resolved:1,src/service.ts:0->src/repo.ts:1:resolved:1,src/service.ts:1->src/other.ts:0:ambiguous:3,src/service.ts:1->src/repo.ts:2:ambiguous:3',
  'a rejected batch changes nothing'
);

-- find_callers ----------------------------------------------------------------------

select is(
  pg_temp.callers('Repo.find'),
  'src/service.ts:4:true:resolved:src/repo.ts#find,src/other.ts:2:false:-:-,src/service.ts:5:false:-:-,src/service.ts:7:false:-:-',
  'linked calls come first; name matches without a resolved edge follow'
);
select is(
  pg_temp.callers('find'),
  'src/service.ts:4:true:resolved:src/repo.ts#find,src/service.ts:5:false:ambiguous:src/other.ts#find,src/other.ts:2:false:-:-,src/service.ts:7:false:-:-',
  'an ambiguous call is reported once, after resolved ones'
);
select is(
  pg_temp.callers('find', 50, 'src/other.ts'),
  'src/service.ts:5:false:ambiguous:src/other.ts#find,src/other.ts:2:false:-:-,src/service.ts:7:false:-:-',
  'p_file narrows targets and drops calls resolved to another file'
);
select is(pg_temp.callers('ignored', 50, null, 'Repo.find'), pg_temp.callers('Repo.find'), 'p_symbol takes precedence over p_name');
select is(pg_temp.callers('Store::make'), 'src/main.cc:3:true:resolved:src/store.cc#make', 'a C++ qualifier matches an out-of-line signature');
select is(pg_temp.callers('Other::make'), '', 'a call resolved to another symbol is not reported by name');
select is(pg_temp.callers('helper'), 'src/service.ts:6:false:-:-', 'unresolved calls are found by name');
select is(pg_temp.callers('find', 1), 'src/service.ts:4:true:resolved:src/repo.ts#find', 'the limit applies across both tiers');
select is(
  (select count(*)::integer from public.find_callers('21212121-0000-4000-8000-000000000004', repeat('a', 40), 'find')),
  4,
  'the 4-argument form still works'
);

-- load_code_link_facts ----------------------------------------------------------------

select is(
  (select string_agg(f ->> 'path', ',') from jsonb_array_elements(public.load_code_link_facts('21212121-0000-4000-8000-000000000004', repeat('a', 40), null, 2)) as f),
  'src/main.cc,src/other.ts',
  'the first page holds parsed files in path order'
);
select is(
  (select string_agg(f ->> 'path', ',') from jsonb_array_elements(public.load_code_link_facts('21212121-0000-4000-8000-000000000004', repeat('a', 40), 'src/other.ts', 10)) as f),
  'src/repo.ts,src/service.ts,src/store.cc',
  'later pages start after the given path and skipped files are left out'
);
select is(
  public.load_code_link_facts('21212121-0000-4000-8000-000000000004', repeat('a', 40), 'src/store.cc', 10),
  '[]'::jsonb,
  'an empty page ends paging'
);
select is(
  (select f - 'path' from jsonb_array_elements(public.load_code_link_facts('21212121-0000-4000-8000-000000000004', repeat('a', 40), 'src/repo.ts', 1)) as f),
  jsonb_build_object(
    'language', 'typescript',
    'symbols', jsonb_build_array(
      jsonb_build_object('name', 'Service', 'kind', 'class', 'parent_ord', null, 'exported', true, 'signature', null),
      jsonb_build_object('name', 'load', 'kind', 'method', 'parent_ord', 0, 'exported', false, 'signature', null)),
    'imports', '[{"source": "./repo", "kind": "static", "names": ["Repo"]}]'::jsonb,
    'calls', '[{"caller_ord": 1, "callee_text": "this.repo.find"}, {"caller_ord": 1, "callee_text": "find"},
               {"caller_ord": 1, "callee_text": "helper"}, {"caller_ord": 1, "callee_text": "ns::find"}]'::jsonb
  ),
  'each file carries the facts the resolver needs, in ordinal order'
);

-- Cascades --------------------------------------------------------------------------

select pg_temp.index(jsonb_build_array(
  pg_temp.file('src/repo.ts', jsonb_build_array(pg_temp.sym('Repo', 'class', null, 1), pg_temp.sym('find', 'method', 0, 2)), '[]')
));
select is(
  pg_temp.stored(),
  'src/main.cc:0->src/store.cc:0:resolved:1,src/service.ts:1->src/other.ts:0:ambiguous:3',
  'rewriting a file drops the edges into it'
);
select pg_temp.index(jsonb_build_array(
  pg_temp.file('src/main.cc', jsonb_build_array(pg_temp.sym('main', 'function', null, 1, 'int main()')), jsonb_build_array(pg_temp.call(0, 'Store::make', 4)), '[]', 'cpp')
));
select is(pg_temp.stored(), 'src/service.ts:1->src/other.ts:0:ambiguous:3', 'rewriting a file drops the edges out of it');

reset role;

delete from public.workspaces where id = '21212121-0000-4000-8000-000000000004';
select is(
  (select count(*)::integer from public.code_call_edges where workspace_id = '21212121-0000-4000-8000-000000000004'),
  0,
  'deleting the workspace cascades to its edges'
);

select * from finish();
rollback;
