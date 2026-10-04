begin;

create extension if not exists pgtap with schema extensions;

select plan(37);

-- Fixtures (as postgres) ---------------------------------------------------------

insert into auth.users (id, email) values
  ('eeeeeeee-0000-4000-8000-000000000001', 'erin@example.com'),
  ('ffffffff-0000-4000-8000-000000000001', 'frank@example.com');

insert into public.repositories (id, user_id, github_repo_id, owner, name, full_name, is_private, default_branch) values
  ('eeeeeeee-0000-4000-8000-000000000003', 'eeeeeeee-0000-4000-8000-000000000001', 3001, 'erin', 'app', 'erin/app', true, 'main'),
  ('ffffffff-0000-4000-8000-000000000003', 'ffffffff-0000-4000-8000-000000000001', 3002, 'frank', 'api', 'frank/api', false, 'main');

insert into public.workspaces (id, user_id, repository_id, status, target_commit_sha) values
  ('eeeeeeee-0000-4000-8000-000000000004', 'eeeeeeee-0000-4000-8000-000000000001', 'eeeeeeee-0000-4000-8000-000000000003', 'analyzing', repeat('e', 40)),
  ('ffffffff-0000-4000-8000-000000000004', 'ffffffff-0000-4000-8000-000000000001', 'ffffffff-0000-4000-8000-000000000003', 'analyzing', repeat('f', 40));

insert into public.jobs (id, user_id, workspace_id, type, status, repository_commit_sha) values
  ('eeeeeeee-0000-4000-8000-000000000005', 'eeeeeeee-0000-4000-8000-000000000001', 'eeeeeeee-0000-4000-8000-000000000004', 'repository_indexing', 'queued', repeat('e', 40)),
  ('ffffffff-0000-4000-8000-000000000005', 'ffffffff-0000-4000-8000-000000000001', 'ffffffff-0000-4000-8000-000000000004', 'repository_indexing', 'running', repeat('f', 40));

create function pg_temp.memory(p_content text) returns jsonb language sql as $$
  select jsonb_build_array(
    jsonb_build_object('kind', 'architecture_summary', 'content', p_content, 'structured', '{"observations": []}'::jsonb,
                       'metadata', '{"analyzer_version": "lightweight-1"}'::jsonb, 'token_count', 3),
    jsonb_build_object('kind', 'technologies', 'content', 'TypeScript', 'token_count', 1)
  );
$$;

-- Schema ------------------------------------------------------------------------

select has_index('public', 'repository_memory', 'repository_memory_workspace_commit_kind_key', 'memory has a per-commit, per-kind unique index');
select col_type_is('public', 'jobs', 'repository_commit_sha', 'git_commit_sha', 'jobs.repository_commit_sha uses the git_commit_sha domain');
select has_column('public', 'jobs', 'error_code', 'jobs has error_code');
select throws_ok(
  $$update public.jobs set stage = 'Scanning files' where id = 'eeeeeeee-0000-4000-8000-000000000005'$$,
  '23514', null, 'jobs.stage only accepts known stages'
);
select throws_ok(
  $$update public.jobs set error_code = 'Not A Code!' where id = 'eeeeeeee-0000-4000-8000-000000000005'$$,
  '23514', null, 'jobs.error_code must be a snake_case code'
);
select throws_ok(
  $$insert into public.jobs (user_id, workspace_id, type, status)
    values ('eeeeeeee-0000-4000-8000-000000000001', 'eeeeeeee-0000-4000-8000-000000000004', 'repository_indexing', 'queued')$$,
  '23505', null, 'only one active analysis per workspace'
);

-- Privileges ----------------------------------------------------------------------

select ok(not has_function_privilege('authenticated', 'public.complete_repository_analysis(uuid, uuid, text, jsonb)', 'EXECUTE'), 'authenticated cannot execute complete_repository_analysis');
select ok(not has_function_privilege('anon', 'public.complete_repository_analysis(uuid, uuid, text, jsonb)', 'EXECUTE'), 'anon cannot execute complete_repository_analysis');
select ok(not has_function_privilege('authenticated', 'public.fail_repository_analysis(uuid, uuid, text, text)', 'EXECUTE'), 'authenticated cannot execute fail_repository_analysis');
select ok(not has_function_privilege('anon', 'public.fail_repository_analysis(uuid, uuid, text, text)', 'EXECUTE'), 'anon cannot execute fail_repository_analysis');
select ok(not has_function_privilege('authenticated', 'public.retry_repository_analysis(uuid, uuid)', 'EXECUTE'), 'authenticated cannot execute retry_repository_analysis');
select ok(not has_function_privilege('anon', 'public.retry_repository_analysis(uuid, uuid)', 'EXECUTE'), 'anon cannot execute retry_repository_analysis');
select ok(has_function_privilege('service_role', 'public.complete_repository_analysis(uuid, uuid, text, jsonb)', 'EXECUTE'), 'service_role can execute complete_repository_analysis');
select ok(
  not (select bool_or(prosecdef) from pg_proc where proname in ('complete_repository_analysis', 'fail_repository_analysis', 'retry_repository_analysis')),
  'analysis functions are security invoker'
);

set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "eeeeeeee-0000-4000-8000-000000000001", "role": "authenticated"}', true);
select throws_ok(
  $$select public.complete_repository_analysis('eeeeeeee-0000-4000-8000-000000000004', 'eeeeeeee-0000-4000-8000-000000000005', repeat('e', 40), '[]')$$,
  '42501', null, 'a signed-in user cannot complete their own analysis'
);
select throws_ok(
  $$select public.retry_repository_analysis('eeeeeeee-0000-4000-8000-000000000004', 'eeeeeeee-0000-4000-8000-000000000001')$$,
  '42501', null, 'a signed-in user cannot call the retry function directly'
);
reset role;

-- complete_repository_analysis ----------------------------------------------------

set local role service_role;

select is(
  public.complete_repository_analysis('eeeeeeee-0000-4000-8000-000000000004', 'eeeeeeee-0000-4000-8000-000000000005', repeat('e', 40), pg_temp.memory('first')),
  true,
  'completing the target commit reports the workspace ready'
);
select is(
  (select status::text || ':' || indexed_commit_sha::text from public.workspaces where id = 'eeeeeeee-0000-4000-8000-000000000004'),
  'ready:' || repeat('e', 40),
  'workspace is ready at the analyzed commit'
);
select is(
  (select status::text || ':' || progress || ':' || coalesce(stage, 'null') from public.jobs where id = 'eeeeeeee-0000-4000-8000-000000000005'),
  'succeeded:100:null',
  'job is marked succeeded at 100%'
);
select is(
  (select count(*) from public.repository_memory where workspace_id = 'eeeeeeee-0000-4000-8000-000000000004'),
  2::bigint,
  'one memory row per kind is stored'
);
select is(
  (select user_id from public.repository_memory where workspace_id = 'eeeeeeee-0000-4000-8000-000000000004' limit 1),
  'eeeeeeee-0000-4000-8000-000000000001'::uuid,
  'memory ownership comes from the workspace, not the caller'
);

create temp table ready_before on commit drop as
select ready_at from public.workspaces where id = 'eeeeeeee-0000-4000-8000-000000000004';

select lives_ok(
  $$select public.complete_repository_analysis('eeeeeeee-0000-4000-8000-000000000004', 'eeeeeeee-0000-4000-8000-000000000005', repeat('e', 40), pg_temp.memory('second'))$$,
  'completing twice is safe'
);
select is(
  (select content from public.repository_memory where workspace_id = 'eeeeeeee-0000-4000-8000-000000000004' and kind = 'architecture_summary'),
  'first',
  'a repeated completion never overwrites existing memory'
);
select is(
  (select count(*) from public.repository_memory where workspace_id = 'eeeeeeee-0000-4000-8000-000000000004'),
  2::bigint,
  'a repeated completion adds no duplicate rows'
);
select is(
  (select ready_at from public.workspaces where id = 'eeeeeeee-0000-4000-8000-000000000004'),
  (select ready_at from ready_before),
  'a repeated completion keeps the original ready_at'
);
select throws_ok(
  $$insert into public.repository_memory (workspace_id, repository_id, user_id, repository_commit_sha, kind, content)
    values ('eeeeeeee-0000-4000-8000-000000000004', 'eeeeeeee-0000-4000-8000-000000000003', 'eeeeeeee-0000-4000-8000-000000000001', repeat('e', 40), 'technologies', 'dup')$$,
  '23505', null, 'memory is unique per workspace, commit, and kind'
);
select throws_ok(
  $$select public.complete_repository_analysis('eeeeeeee-0000-4000-8000-000000000004', 'ffffffff-0000-4000-8000-000000000005', repeat('e', 40), '[]')$$,
  'P0002', 'job_not_found', 'a job from another workspace cannot complete this workspace'
);
select throws_ok(
  $$select public.complete_repository_analysis('eeeeeeee-0000-4000-8000-000000000004', 'eeeeeeee-0000-4000-8000-000000000005', repeat('e', 40), '{}')$$,
  '22023', 'memory_must_be_array', 'memory must be a JSON array'
);

-- fail_repository_analysis ----------------------------------------------------------

select lives_ok(
  $$select public.fail_repository_analysis('eeeeeeee-0000-4000-8000-000000000004', 'eeeeeeee-0000-4000-8000-000000000005', 'internal_error', 'late failure')$$,
  'a late failure for a succeeded job is a no-op'
);
select is(
  (select status::text from public.jobs where id = 'eeeeeeee-0000-4000-8000-000000000005') || '/' ||
  (select status::text from public.workspaces where id = 'eeeeeeee-0000-4000-8000-000000000004'),
  'succeeded/ready',
  'a succeeded job and ready workspace are never downgraded'
);

select public.fail_repository_analysis('ffffffff-0000-4000-8000-000000000004', 'ffffffff-0000-4000-8000-000000000005', 'github_unavailable', 'GitHub is unavailable');
select is(
  (select status::text || ':' || error_code from public.jobs where id = 'ffffffff-0000-4000-8000-000000000005') || '/' ||
  (select status::text from public.workspaces where id = 'ffffffff-0000-4000-8000-000000000004'),
  'failed:github_unavailable/failed',
  'a failure marks the job and the analyzing workspace failed'
);

-- retry_repository_analysis -----------------------------------------------------------

select is(
  public.retry_repository_analysis('ffffffff-0000-4000-8000-000000000004', 'eeeeeeee-0000-4000-8000-000000000001'),
  null,
  'another user cannot retry the workspace'
);
select is(
  public.retry_repository_analysis('eeeeeeee-0000-4000-8000-000000000004', 'eeeeeeee-0000-4000-8000-000000000001'),
  null,
  'a ready workspace cannot be retried'
);

create temp table retried on commit drop as
select public.retry_repository_analysis('ffffffff-0000-4000-8000-000000000004', 'ffffffff-0000-4000-8000-000000000001') as job_id;

select is(
  (select status::text || ':' || repository_commit_sha::text from public.jobs where id = (select job_id from retried)) || '/' ||
  (select status::text from public.workspaces where id = 'ffffffff-0000-4000-8000-000000000004'),
  'queued:' || repeat('f', 40) || '/analyzing',
  'retry queues a new job for the target commit and resets the workspace'
);
select is(
  public.retry_repository_analysis('ffffffff-0000-4000-8000-000000000004', 'ffffffff-0000-4000-8000-000000000001'),
  null,
  'a second (double-clicked) retry is rejected'
);

reset role;

-- Cross-user reads -----------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "ffffffff-0000-4000-8000-000000000001", "role": "authenticated"}', true);

select is(
  (select count(*) from public.repository_memory where user_id = 'eeeeeeee-0000-4000-8000-000000000001'),
  0::bigint,
  'Frank cannot read Erin''s repository memory'
);
select is(
  (select count(*) from public.jobs where user_id = 'eeeeeeee-0000-4000-8000-000000000001'),
  0::bigint,
  'Frank cannot read Erin''s jobs'
);

reset role;

select * from finish();

rollback;
