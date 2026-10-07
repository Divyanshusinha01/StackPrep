begin;

create extension if not exists pgtap with schema extensions;

select plan(22);

-- Fixtures ------------------------------------------------------------------

insert into auth.users (id, email) values
  ('99999999-0000-4000-8000-000000000001', 'mia@example.com');

insert into public.repositories (id, user_id, github_repo_id, owner, name, full_name, is_private, default_branch) values
  ('99999999-0000-4000-8000-000000000003', '99999999-0000-4000-8000-000000000001', 9001, 'mia', 'web', 'mia/web', false, 'main');

insert into public.workspaces (id, user_id, repository_id, status, target_commit_sha, indexed_commit_sha, ready_at) values
  ('99999999-0000-4000-8000-000000000004', '99999999-0000-4000-8000-000000000001', '99999999-0000-4000-8000-000000000003', 'ready', repeat('b', 40), repeat('b', 40), now());

-- Commit a has already been deep-analyzed; commit b only has baseline memory; commit c has none.
insert into public.repository_memory (workspace_id, repository_id, user_id, repository_commit_sha, kind, content, structured, metadata) values
  ('99999999-0000-4000-8000-000000000004', '99999999-0000-4000-8000-000000000003', '99999999-0000-4000-8000-000000000001', repeat('a', 40), 'architecture_summary', 'old', '{}', '{"deep_analysis": {"model": "m"}}'),
  ('99999999-0000-4000-8000-000000000004', '99999999-0000-4000-8000-000000000003', '99999999-0000-4000-8000-000000000001', repeat('b', 40), 'architecture_summary', 'Next.js app', '{"observations": ["x"]}', '{"analyzer_version": "lightweight-1"}'),
  ('99999999-0000-4000-8000-000000000004', '99999999-0000-4000-8000-000000000003', '99999999-0000-4000-8000-000000000001', repeat('b', 40), 'modules', 'src/', '{"modules": [{"name": "src"}]}', '{}');

create function pg_temp.request(p_sha text) returns uuid language sql as $$
  select public.request_deep_analysis('99999999-0000-4000-8000-000000000004', p_sha);
$$;

create function pg_temp.payload(p_summary text) returns jsonb language sql as $$
  select jsonb_build_object(
    'model', 'gpt-test',
    'analyzer_version', 1,
    'architecture_summary', jsonb_build_object('summary', p_summary),
    'modules', jsonb_build_object('modules', '[{"name": "src"}]'::jsonb),
    'concepts', jsonb_build_object('content', 'react: UI library', 'ai', jsonb_build_object(
      'concepts', '[{"term": "React", "normalized_term": "react", "explanation": "UI library"}]'::jsonb))
  );
$$;

-- Schema and privileges -------------------------------------------------------------------

select has_index('public', 'jobs', 'jobs_active_deep_analysis_key', 'jobs has the active deep analysis index');
select ok(
  (select pg_get_constraintdef(oid) like '%''deep_analysis''%' from pg_constraint where conname = 'jobs_stage_check'),
  'jobs.stage accepts deep_analysis'
);
select ok(not has_function_privilege('authenticated', 'public.request_deep_analysis(uuid, text)', 'EXECUTE'), 'authenticated cannot execute request_deep_analysis');
select ok(not has_function_privilege('authenticated', 'public.save_deep_analysis(uuid, uuid, text, jsonb)', 'EXECUTE'), 'authenticated cannot execute save_deep_analysis');
select ok(not has_function_privilege('authenticated', 'public.fail_deep_analysis(uuid, uuid, text, text)', 'EXECUTE'), 'authenticated cannot execute fail_deep_analysis');
select ok(has_function_privilege('service_role', 'public.save_deep_analysis(uuid, uuid, text, jsonb)', 'EXECUTE'), 'service_role can execute save_deep_analysis');
select ok(
  not exists (select 1 from pg_proc where proname in ('request_deep_analysis', 'save_deep_analysis', 'fail_deep_analysis') and prosecdef),
  'the deep analysis functions are security invoker'
);

set local role service_role;

-- request_deep_analysis -------------------------------------------------------------------

select is(pg_temp.request(repeat('c', 40)), null, 'a commit without baseline memory gets no job');
select is(pg_temp.request(repeat('a', 40)), null, 'an already analyzed commit gets no job');
create temp table first_job as select pg_temp.request(repeat('b', 40)) as id;
select ok((select id is not null from first_job), 'the marker on an older commit does not suppress a new commit');
select is(pg_temp.request(repeat('b', 40)), null, 'a second request while one is active is a no-op');
select is(
  (select user_id::text || ':' || repository_commit_sha::text from public.jobs where id = (select id from first_job)),
  '99999999-0000-4000-8000-000000000001:' || repeat('b', 40),
  'the job is owned by the workspace user and pinned to the commit'
);

-- save_deep_analysis ----------------------------------------------------------------------

select throws_ok(
  $$select public.save_deep_analysis('99999999-0000-4000-8000-000000000004', (select id from first_job), repeat('b', 40), '{}')$$,
  '22023', 'invalid_deep_analysis_payload', 'the payload must have the expected shape'
);
select throws_ok(
  $$select public.save_deep_analysis('99999999-0000-4000-8000-000000000004', (select id from first_job), repeat('a', 40), pg_temp.payload('x'))$$,
  'P0002', 'deep_analysis_job_not_found', 'a job cannot save another commit''s analysis'
);
select lives_ok(
  $$select public.save_deep_analysis('99999999-0000-4000-8000-000000000004', (select id from first_job), repeat('b', 40), pg_temp.payload('v1'))$$,
  'the analysis is saved'
);
select lives_ok(
  $$select public.save_deep_analysis('99999999-0000-4000-8000-000000000004', (select id from first_job), repeat('b', 40), pg_temp.payload('v2'))$$,
  'saving again is idempotent'
);
select is(
  (select structured #>> '{ai,summary}' || '|' || (structured ? 'observations')::text || '|' || (metadata #>> '{deep_analysis,model}')
   from public.repository_memory
   where workspace_id = '99999999-0000-4000-8000-000000000004' and repository_commit_sha = repeat('b', 40) and kind = 'architecture_summary'),
  'v2|true|gpt-test',
  'structured.ai is replaced, baseline fields are kept, and the marker is stamped'
);
select is(
  (select count(*) || ':' || max(jsonb_array_length(structured #> '{ai,concepts}'))
   from public.repository_memory
   where workspace_id = '99999999-0000-4000-8000-000000000004' and repository_commit_sha = repeat('b', 40) and kind = 'concepts'),
  '1:1',
  'one concepts row per commit, with concepts replaced instead of appended'
);
select is(
  (select status::text || ':' || progress from public.jobs where id = (select id from first_job)),
  'succeeded:100',
  'saving marks the job succeeded'
);
select is(pg_temp.request(repeat('b', 40)), null, 'an analyzed commit gets no new job');

-- fail_deep_analysis ----------------------------------------------------------------------

select public.fail_deep_analysis('99999999-0000-4000-8000-000000000004', (select id from first_job), 'internal_error', 'late failure');
select is(
  (select status::text from public.jobs where id = (select id from first_job)) || '/' ||
  (select status::text from public.workspaces where id = '99999999-0000-4000-8000-000000000004'),
  'succeeded/ready',
  'a late failure never downgrades the job or touches the workspace'
);

reset role;
update public.repository_memory set metadata = metadata - 'deep_analysis'
where workspace_id = '99999999-0000-4000-8000-000000000004' and repository_commit_sha = repeat('b', 40) and kind = 'architecture_summary';
set local role service_role;

create temp table second_job as select pg_temp.request(repeat('b', 40)) as id;
select public.fail_deep_analysis('99999999-0000-4000-8000-000000000004', (select id from second_job), 'ai_unavailable', 'AI provider is unavailable');
select is(
  (select status::text || ':' || error_code from public.jobs where id = (select id from second_job)) || '/' ||
  (select status::text from public.workspaces where id = '99999999-0000-4000-8000-000000000004'),
  'failed:ai_unavailable/ready',
  'a failure marks only the job failed'
);

reset role;

select * from finish();

rollback;
