begin;

create extension if not exists pgtap with schema extensions;

select plan(46);

-- Fixtures ------------------------------------------------------------------
-- One GitHub repository (9001) shared by four users through installation 501:
--   alice  ready workspace, active connection
--   bob    ready workspace, active connection
--   carol  ready workspace, suspended connection
--   dave   analyzing workspace, active connection

insert into auth.users (id, email) values
  ('20202020-0000-4000-8000-00000000000a', 'alice@example.com'),
  ('20202020-0000-4000-8000-00000000000b', 'bob@example.com'),
  ('20202020-0000-4000-8000-00000000000c', 'carol@example.com'),
  ('20202020-0000-4000-8000-00000000000d', 'dave@example.com');

-- Pending pushes are only listed for owners with a valid OpenAI key (22_openai_credentials covers the filter).
insert into public.openai_credentials (user_id, credential_id, ciphertext, iv, enc_key_version, key_hint)
select u.id, gen_random_uuid(), extensions.gen_random_bytes(48), extensions.gen_random_bytes(12), 1, 'sk-...test'
from auth.users as u where u.id::text like '20202020-%';

insert into public.github_connections (id, user_id, github_user_id, installation_id, account_login, suspended_at) values
  ('20202020-0000-4000-8000-0000000001a0', '20202020-0000-4000-8000-00000000000a', 1, 501, 'acme', null),
  ('20202020-0000-4000-8000-0000000001b0', '20202020-0000-4000-8000-00000000000b', 2, 501, 'acme', null),
  ('20202020-0000-4000-8000-0000000001c0', '20202020-0000-4000-8000-00000000000c', 3, 501, 'acme', now()),
  ('20202020-0000-4000-8000-0000000001d0', '20202020-0000-4000-8000-00000000000d', 4, 501, 'acme', null);

insert into public.repositories (id, user_id, github_connection_id, github_repo_id, owner, name, full_name, is_private, default_branch) values
  ('20202020-0000-4000-8000-0000000002a0', '20202020-0000-4000-8000-00000000000a', '20202020-0000-4000-8000-0000000001a0', 9001, 'acme', 'api', 'acme/api', true, 'main'),
  ('20202020-0000-4000-8000-0000000002b0', '20202020-0000-4000-8000-00000000000b', '20202020-0000-4000-8000-0000000001b0', 9001, 'acme', 'api', 'acme/api', true, 'main'),
  ('20202020-0000-4000-8000-0000000002c0', '20202020-0000-4000-8000-00000000000c', '20202020-0000-4000-8000-0000000001c0', 9001, 'acme', 'api', 'acme/api', true, 'main'),
  ('20202020-0000-4000-8000-0000000002d0', '20202020-0000-4000-8000-00000000000d', '20202020-0000-4000-8000-0000000001d0', 9001, 'acme', 'api', 'acme/api', true, 'main');

insert into public.workspaces (id, user_id, repository_id, status, target_commit_sha, indexed_commit_sha, ready_at) values
  ('20202020-0000-4000-8000-0000000003a0', '20202020-0000-4000-8000-00000000000a', '20202020-0000-4000-8000-0000000002a0', 'ready', repeat('a', 40), repeat('a', 40), now()),
  ('20202020-0000-4000-8000-0000000003b0', '20202020-0000-4000-8000-00000000000b', '20202020-0000-4000-8000-0000000002b0', 'ready', repeat('a', 40), repeat('a', 40), now()),
  ('20202020-0000-4000-8000-0000000003c0', '20202020-0000-4000-8000-00000000000c', '20202020-0000-4000-8000-0000000002c0', 'ready', repeat('a', 40), repeat('a', 40), now()),
  ('20202020-0000-4000-8000-0000000003d0', '20202020-0000-4000-8000-00000000000d', '20202020-0000-4000-8000-0000000002d0', 'analyzing', repeat('a', 40), null, null);

create function pg_temp.ws(p_user text) returns uuid language sql as $$
  select ('20202020-0000-4000-8000-0000000003' || p_user || '0')::uuid;
$$;

create function pg_temp.generations(p_user text) returns text language sql as $$
  select push_generation || '/' || synced_generation from public.workspaces where id = pg_temp.ws(p_user);
$$;

create function pg_temp.commits(p_user text) returns text language sql as $$
  select left(target_commit_sha, 1) || '/' || left(indexed_commit_sha, 1) || '/' || status::text
  from public.workspaces where id = pg_temp.ws(p_user);
$$;

create function pg_temp.follow(p_user text, p_sha text, p_observed bigint) returns text language sql as $$
  select f.outcome || ':' || (f.job_id is not null)::text
  from public.follow_repository_head(pg_temp.ws(p_user), p_sha, p_observed) as f;
$$;

create function pg_temp.pending() returns text language sql as $$
  select coalesce(string_agg(right(p.workspace_id::text, 2) || '@' || p.installation_id || '#' || p.push_generation, ',' order by p.workspace_id), '')
  from public.list_pending_push_workspaces(100) as p;
$$;

-- Every key the code index mapper emits, so stored and reloaded payloads hash the same.
create function pg_temp.parsed(p_path text, p_blob text) returns jsonb language sql as $$
  select jsonb_build_object(
    'path', p_path, 'blob_sha', p_blob, 'language', 'typescript', 'size_bytes', 120, 'line_count', 9,
    'parse_status', 'ok', 'parse_error_count', 0, 'skipped_reason', null,
    'stats', '{"node_count": 40, "limits_hit": [], "exports": 1, "calls_dropped": 0}'::jsonb,
    'symbols', jsonb_build_array(
      jsonb_build_object('name', 'Service', 'kind', 'class', 'parent_ord', null, 'start_line', 2, 'start_col', 1,
        'end_line', 9, 'end_col', 2, 'exported', true, 'signature', 'export class Service'),
      jsonb_build_object('name', 'load', 'kind', 'method', 'parent_ord', 0, 'start_line', 3, 'start_col', 3,
        'end_line', 5, 'end_col', 4, 'exported', false, 'signature', null)
    ),
    'imports', jsonb_build_array(
      jsonb_build_object('source', './db', 'kind', 'static', 'names', '["db"]'::jsonb, 'resolved_path', 'src/db.ts', 'line', 1)
    ),
    'calls', jsonb_build_array(
      jsonb_build_object('caller_ord', 1, 'callee_text', 'this.db.from', 'line', 4, 'col', 5)
    )
  );
$$;

create function pg_temp.skipped(p_path text, p_blob text, p_reason text) returns jsonb language sql as $$
  select jsonb_build_object(
    'path', p_path, 'blob_sha', p_blob, 'language', 'typescript', 'size_bytes', 10, 'line_count', null,
    'parse_status', 'skipped', 'parse_error_count', 0, 'skipped_reason', p_reason, 'stats', '{}'::jsonb,
    'symbols', '[]'::jsonb, 'imports', '[]'::jsonb, 'calls', '[]'::jsonb
  );
$$;

create function pg_temp.reuse(p_version text, p_files jsonb) returns jsonb language sql as $$
  select public.load_reusable_code_files(pg_temp.ws('a'), p_version, p_files);
$$;

create function pg_temp.pair(p_path text, p_blob text) returns jsonb language sql as $$
  select jsonb_build_array(jsonb_build_object('path', p_path, 'blob_sha', p_blob));
$$;

-- Schema and privileges -------------------------------------------------------------

select has_column('public', 'workspaces', 'push_generation', 'workspaces has push_generation');
select has_column('public', 'workspaces', 'synced_generation', 'workspaces has synced_generation');
select throws_ok(
  $$update public.workspaces set synced_generation = 1 where id = '20202020-0000-4000-8000-0000000003a0'$$,
  '23514', null, 'synced_generation can never pass push_generation'
);
select ok(
  not (
    has_function_privilege('authenticated', 'public.mark_push_received(bigint, bigint)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.follow_repository_head(uuid, text, bigint)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.reopen_push_sync(uuid, bigint)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.list_pending_push_workspaces(integer)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.load_reusable_code_files(uuid, text, jsonb)', 'EXECUTE')
    or has_function_privilege('anon', 'public.mark_push_received(bigint, bigint)', 'EXECUTE')
    or has_function_privilege('anon', 'public.follow_repository_head(uuid, text, bigint)', 'EXECUTE')
    or has_function_privilege('anon', 'public.load_reusable_code_files(uuid, text, jsonb)', 'EXECUTE')
  ),
  'push sync functions are not callable by anon or authenticated'
);
select ok(
  has_function_privilege('service_role', 'public.mark_push_received(bigint, bigint)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.follow_repository_head(uuid, text, bigint)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.reopen_push_sync(uuid, bigint)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.list_pending_push_workspaces(integer)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.load_reusable_code_files(uuid, text, jsonb)', 'EXECUTE'),
  'service_role can execute the push sync functions'
);
select ok(
  not (select bool_or(prosecdef) from pg_proc where proname in (
    'mark_push_received', 'follow_repository_head', 'reopen_push_sync', 'list_pending_push_workspaces', 'load_reusable_code_files'
  )),
  'push sync functions are security invoker'
);

set local role service_role;

-- mark_push_received ----------------------------------------------------------------

select is(
  (select array_agg(id order by id) from public.mark_push_received(9001, 501) as id),
  array[pg_temp.ws('a'), pg_temp.ws('b')],
  'only ready workspaces with an active connection for the installation are marked'
);
select is(
  pg_temp.generations('a') || ',' || pg_temp.generations('b') || ',' || pg_temp.generations('c') || ',' || pg_temp.generations('d'),
  '1/0,1/0,0/0,0/0',
  'marking increments push_generation of the returned workspaces only'
);
select is(
  (select count(*) from public.mark_push_received(9001, 999)),
  0::bigint,
  'another installation marks nothing'
);
select is(
  (select count(*) from public.mark_push_received(4242, 501)),
  0::bigint,
  'an unknown repository marks nothing'
);

-- list_pending_push_workspaces ------------------------------------------------------

reset role;
update public.workspaces set push_generation = 1 where id = pg_temp.ws('c');
set local role service_role;

select is(pg_temp.pending(), 'a0@501#1,b0@501#1', 'pending lists marked workspaces and skips suspended connections');

-- follow_repository_head ------------------------------------------------------------

select is(pg_temp.follow('d', repeat('c', 40), 0), 'not_ready:false', 'a workspace that is not ready is not followed');
select is(
  pg_temp.follow('a', repeat('c', 40), 1),
  'queued:true',
  'a new head is queued'
);
select is(pg_temp.commits('a'), 'c/a/ready', 'the target moves, the indexed commit and readiness do not');
select is(pg_temp.generations('a'), '1/1', 'the observed generation is synced');
select is(
  (select status::text || ':' || left(repository_commit_sha, 1) from public.jobs
   where workspace_id = pg_temp.ws('a') and type = 'repository_indexing'),
  'queued:c',
  'one queued baseline for the new head'
);
select is(pg_temp.pending(), 'b0@501#1', 'a synced workspace is no longer pending');

select is((select count(*) from public.mark_push_received(9001, 501)), 2::bigint, 'a second push is marked');
select is(pg_temp.pending(), 'b0@501#2', 'a workspace with an active analysis is not listed');
select is(pg_temp.follow('a', repeat('e', 40), 2), 'analysis_active:false', 'an active analysis defers the sync');
select is(pg_temp.commits('a') || ' ' || pg_temp.generations('a'), 'c/a/ready 2/1', 'a deferred sync changes nothing');

select public.fail_repository_analysis(
  pg_temp.ws('a'),
  (select id from public.jobs where workspace_id = pg_temp.ws('a') and status = 'queued'),
  'github_unavailable', 'GitHub is unavailable'
);
select is(pg_temp.commits('a'), 'c/a/ready', 'a failed baseline leaves the workspace ready at the indexed commit');
select is(pg_temp.pending(), 'a0@501#2,b0@501#2', 'the pending push is listed again once nothing is active');

create temp table retried on commit drop as
select * from public.follow_repository_head(pg_temp.ws('a'), repeat('c', 40), 2);
select is(
  (select outcome from retried),
  'queued',
  'a head equal to a target whose baseline failed is queued again'
);
select is(pg_temp.commits('a'), 'c/a/ready', 'the indexed commit is unchanged while the analysis runs');

select public.complete_repository_analysis(pg_temp.ws('a'), (select job_id from retried), repeat('c', 40), '[]');
select is(pg_temp.commits('a'), 'c/c/ready', 'only completing the target analysis moves the indexed commit');

reset role;
insert into public.jobs (user_id, workspace_id, type, status, repository_commit_sha)
values ('20202020-0000-4000-8000-00000000000a', pg_temp.ws('a'), 'deep_analysis', 'running', repeat('c', 40));
set local role service_role;

select is((select count(*) from public.mark_push_received(9001, 501)), 2::bigint, 'a third push is marked');
select is(pg_temp.follow('a', repeat('c', 40), 3), 'analysis_active:false', 'an active deep analysis also defers the sync');
select is(pg_temp.pending(), 'b0@501#3', 'an active deep analysis keeps the workspace out of the pending list');

reset role;
update public.jobs set status = 'succeeded' where workspace_id = pg_temp.ws('a') and type = 'deep_analysis';
set local role service_role;

select is(pg_temp.follow('a', repeat('c', 40), 2), 'up_to_date:false', 'the indexed head is up to date');
select is(pg_temp.generations('a'), '3/2', 'a push marked after the observation stays pending');
select is(pg_temp.follow('a', repeat('c', 40), 3), 'up_to_date:false', 'the next sync clears it');
select is(pg_temp.generations('a'), '3/3', 'synced_generation reaches the observed generation');
select is(pg_temp.follow('a', repeat('c', 40), 1), 'up_to_date:false', 'an older observation is harmless');
select is(pg_temp.generations('a'), '3/3', 'synced_generation never moves backwards');

-- Force-push rewind to the indexed commit after a failed newer target.
select is(pg_temp.follow('b', repeat('f', 40), 3), 'queued:true', 'bob follows a force-pushed head');
select public.fail_repository_analysis(
  pg_temp.ws('b'),
  (select id from public.jobs where workspace_id = pg_temp.ws('b') and status = 'queued'),
  'repository_unavailable', 'The repository or commit is no longer accessible'
);
select is(pg_temp.follow('b', repeat('a', 40), 3), 'up_to_date:false', 'a rewind to the indexed commit is up to date');
select is(pg_temp.commits('b'), 'a/a/ready', 'the rewind resets the target to the indexed commit');

-- reopen_push_sync ------------------------------------------------------------------

select is(public.reopen_push_sync(pg_temp.ws('a'), 3), true, 'reopening the observed sync makes the push pending again');
select is(public.reopen_push_sync(pg_temp.ws('a'), 3), false, 'reopening never rolls back a sync it did not make');
select is(pg_temp.generations('a'), '3/2', 'the push stays pending exactly once');

-- load_reusable_code_files ----------------------------------------------------------

select public.replace_code_index(pg_temp.ws('a'), repeat('a', 40), '1', jsonb_build_array(
  pg_temp.parsed('src/service.ts', repeat('1', 40)),
  pg_temp.skipped('src/flaky.ts', repeat('2', 40), 'fetch_failed'),
  pg_temp.skipped('src/secret.ts', repeat('3', 40), 'secret')
));

select is(
  pg_temp.reuse('1', pg_temp.pair('src/service.ts', repeat('1', 40))),
  jsonb_build_array(pg_temp.parsed('src/service.ts', repeat('1', 40))),
  'an exact match returns the stored payload with facts in ord order'
);
select is(
  jsonb_array_length(pg_temp.reuse('2', pg_temp.pair('src/service.ts', repeat('1', 40))))
  || '/' || jsonb_array_length(pg_temp.reuse('1', pg_temp.pair('src/service.ts', repeat('9', 40))))
  || '/' || jsonb_array_length(pg_temp.reuse('1', pg_temp.pair('src/moved.ts', repeat('1', 40)))),
  '0/0/0',
  'another parser version, blob or path is never reused'
);
select is(
  (select array_agg(p ->> 'path' order by p ->> 'path') from jsonb_array_elements(pg_temp.reuse('1', jsonb_build_array(
    jsonb_build_object('path', 'src/flaky.ts', 'blob_sha', repeat('2', 40)),
    jsonb_build_object('path', 'src/secret.ts', 'blob_sha', repeat('3', 40))
  ))) as p),
  array['src/secret.ts'],
  'fetch failures are never reused but deterministic skips are'
);

select public.replace_code_index(pg_temp.ws('a'), repeat('c', 40), '1',
  pg_temp.reuse('1', pg_temp.pair('src/service.ts', repeat('1', 40))));
select is(
  (select count(distinct facts_hash) || '/' || count(*) from public.code_files
   where workspace_id = pg_temp.ws('a') and path = 'src/service.ts'),
  '1/2',
  'a reused payload written at another commit has the same facts hash'
);
select throws_ok(
  $$select public.load_reusable_code_files('20202020-0000-4000-8000-0000000003a0', '1', '[{"path": 1}]')$$,
  '22023', 'invalid_code_index_payload', 'a malformed lookup is rejected'
);

reset role;

select * from finish();

rollback;
