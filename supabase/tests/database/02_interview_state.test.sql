begin;

create extension if not exists pgtap with schema extensions;

select plan(19);

-- Fixtures ------------------------------------------------------------------

insert into auth.users (id, email) values
  ('cccccccc-0000-4000-8000-000000000001', 'carol@example.com'),
  ('dddddddd-0000-4000-8000-000000000001', 'dave@example.com');

insert into public.repositories (id, user_id, github_repo_id, owner, name, full_name, is_private, default_branch) values
  ('cccccccc-0000-4000-8000-000000000003', 'cccccccc-0000-4000-8000-000000000001', 2001, 'carol', 'web', 'carol/web', false, 'main');

insert into public.workspaces (id, user_id, repository_id, status, indexed_commit_sha, ready_at) values
  ('cccccccc-0000-4000-8000-000000000004', 'cccccccc-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000003', 'ready', repeat('c', 40), now());

-- Each helper ends with SET CONSTRAINTS ALL IMMEDIATE so deferred constraint triggers fire
-- inside throws_ok/lives_ok (this file runs in one transaction that never commits).
create function pg_temp.insert_bare_interview() returns void language plpgsql as $$
begin
  insert into public.interviews (workspace_id, user_id, interview_number, repository_commit_sha)
  values ('cccccccc-0000-4000-8000-000000000004', 'cccccccc-0000-4000-8000-000000000001', 99, repeat('c', 40));
  set constraints all immediate;
end;
$$;

-- Flushes checks queued by earlier inserts first, as if the interview had been committed
-- in a previous transaction.
create function pg_temp.delete_state(p_interview_id uuid) returns void language plpgsql as $$
begin
  set constraints all immediate;
  set constraints all deferred;
  delete from public.interview_state where interview_id = p_interview_id;
  set constraints all immediate;
end;
$$;

create function pg_temp.delete_interview(p_interview_id uuid) returns void language plpgsql as $$
begin
  delete from public.interviews where id = p_interview_id;
  set constraints all immediate;
end;
$$;

set local role service_role;

-- create_interview ------------------------------------------------------------

create temp table created on commit drop as
select * from public.create_interview(
  'cccccccc-0000-4000-8000-000000000004', 'cccccccc-0000-4000-8000-000000000001', repeat('c', 40),
  '{"backend": "untested"}', '{"areas": ["backend"]}', '{"depth": 1}'
);

select is((select interview_number from created), 1, 'first interview in a workspace is number 1');
select is(
  (select version from public.interview_state where interview_id = (select id from created)),
  1::bigint,
  'create_interview inserts interview_state at version 1'
);
select is(
  (select coverage_map from public.interview_state where interview_id = (select id from created)),
  '{"backend": "untested"}'::jsonb,
  'create_interview stores the initial coverage map'
);
select is(
  (select (public.create_interview('cccccccc-0000-4000-8000-000000000004', 'cccccccc-0000-4000-8000-000000000001', repeat('c', 40), '{}', '{}', '{}')).interview_number),
  2,
  'next interview in the same workspace is number 2'
);
select throws_ok(
  $$select public.create_interview('cccccccc-0000-4000-8000-000000000004', 'dddddddd-0000-4000-8000-000000000001', repeat('c', 40), '{}', '{}', '{}')$$,
  '42501', 'workspace_not_owned', 'create_interview rejects a user who does not own the workspace'
);
select throws_ok(
  $$select public.create_interview(gen_random_uuid(), 'cccccccc-0000-4000-8000-000000000001', repeat('c', 40), '{}', '{}', '{}')$$,
  'P0002', 'workspace_not_found', 'create_interview rejects an unknown workspace'
);
select throws_ok(
  $$select public.create_interview('cccccccc-0000-4000-8000-000000000004', 'cccccccc-0000-4000-8000-000000000001', 'not-a-sha', '{}', '{}', '{}')$$,
  '23514', null, 'create_interview rejects an invalid commit SHA'
);

-- Interview/state pairing ------------------------------------------------------

select throws_ok(
  'select pg_temp.insert_bare_interview()',
  '23514', 'interview_missing_state', 'an interview inserted without state fails at commit time'
);
select throws_ok(
  format('select pg_temp.delete_state(%L)', (select id from created)),
  '23514', 'interview_state_delete_forbidden', 'interview_state cannot be deleted while its interview exists'
);
select throws_ok(
  format($$update public.interview_state set interview_id = gen_random_uuid() where interview_id = %L$$, (select id from created)),
  '42501', null, 'interview_state cannot be re-pointed to another interview'
);

-- Optimistic concurrency -------------------------------------------------------

select is(
  public.update_interview_state((select id from created), 1, '{"backend": "covered"}', '{"areas": ["backend"]}', '{"depth": 2}'),
  2::bigint,
  'update with the current version returns version + 1'
);
select throws_ok(
  format($$select public.update_interview_state(%L, 1, '{"backend": "stale"}', '{}', '{}')$$, (select id from created)),
  'P0409', 'stale_interview_state', 'update with a stale version raises P0409'
);
select is(
  (select coverage_map from public.interview_state where interview_id = (select id from created)),
  '{"backend": "covered"}'::jsonb,
  'the stale write did not change state'
);
select throws_ok(
  $$select public.update_interview_state(gen_random_uuid(), 1, '{}', '{}', '{}')$$,
  'P0409', 'stale_interview_state', 'update for an unknown interview raises P0409'
);

-- Status constraints ---------------------------------------------------------

select throws_ok(
  format($$update public.interviews set termination_reason = 'integrity_violation' where id = %L$$, (select id from created)),
  '23514', null, 'termination_reason requires a terminated or completed status'
);
select throws_ok(
  format($$update public.interviews set status = 'terminated' where id = %L$$, (select id from created)),
  '23514', null, 'a terminated interview must record a termination_reason'
);
select throws_ok(
  format($$update public.interviews set integrity_warning_count = 4 where id = %L$$, (select id from created)),
  '23514', null, 'integrity_warning_count cannot exceed 3'
);

-- Cascade delete -------------------------------------------------------------

insert into public.interview_messages (interview_id, user_id, sequence, role, content)
select id, user_id, 1, 'ai', 'Walk me through the data model.' from created;
insert into public.interview_events (interview_id, user_id, sequence, event_type)
select id, user_id, 1, 'start' from created;

select lives_ok(
  format('select pg_temp.delete_interview(%L)', (select id from created)),
  'deleting an interview cascades to its state, messages, and events'
);
select is(
  (select count(*) from public.interview_state where interview_id = (select id from created))
  + (select count(*) from public.interview_messages where interview_id = (select id from created))
  + (select count(*) from public.interview_events where interview_id = (select id from created)),
  0::bigint,
  'no child rows remain after deleting the interview'
);

reset role;

select * from finish();

rollback;
