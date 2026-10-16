begin;

create extension if not exists pgtap with schema extensions;

select plan(38);

-- Fixtures ------------------------------------------------------------------
--   kim  has a key and a ready workspace with a pending push
--   lee  has no key and a ready workspace with a pending push

insert into auth.users (id, email) values
  ('22222222-0000-4000-8000-00000000000a', 'kim@example.com'),
  ('22222222-0000-4000-8000-00000000000b', 'lee@example.com');

insert into public.github_connections (id, user_id, github_user_id, installation_id, account_login) values
  ('22222222-0000-4000-8000-0000000001a0', '22222222-0000-4000-8000-00000000000a', 221, 2201, 'kim'),
  ('22222222-0000-4000-8000-0000000001b0', '22222222-0000-4000-8000-00000000000b', 222, 2202, 'lee');

insert into public.repositories (id, user_id, github_connection_id, github_repo_id, owner, name, full_name, is_private, default_branch) values
  ('22222222-0000-4000-8000-0000000002a0', '22222222-0000-4000-8000-00000000000a', '22222222-0000-4000-8000-0000000001a0', 22001, 'kim', 'api', 'kim/api', false, 'main'),
  ('22222222-0000-4000-8000-0000000002b0', '22222222-0000-4000-8000-00000000000b', '22222222-0000-4000-8000-0000000001b0', 22002, 'lee', 'api', 'lee/api', false, 'main');

insert into public.workspaces (id, user_id, repository_id, status, target_commit_sha, indexed_commit_sha, ready_at, push_generation) values
  ('22222222-0000-4000-8000-0000000003a0', '22222222-0000-4000-8000-00000000000a', '22222222-0000-4000-8000-0000000002a0', 'ready', repeat('a', 40), repeat('a', 40), now(), 1),
  ('22222222-0000-4000-8000-0000000003b0', '22222222-0000-4000-8000-00000000000b', '22222222-0000-4000-8000-0000000002b0', 'ready', repeat('a', 40), repeat('a', 40), now(), 1);

create function pg_temp.kim() returns uuid language sql as $$ select '22222222-0000-4000-8000-00000000000a'::uuid $$;
create function pg_temp.lee() returns uuid language sql as $$ select '22222222-0000-4000-8000-00000000000b'::uuid $$;

create function pg_temp.save(p_user uuid, p_credential uuid, p_hint text) returns void language sql as $$
  select public.upsert_openai_credential(
    p_user, p_credential, extensions.gen_random_bytes(48), extensions.gen_random_bytes(12), 1::smallint, p_hint
  );
$$;

create function pg_temp.state(p_user uuid) returns text language sql as $$
  select coalesce(
    (select status::text || '/' || coalesce(last_error_code, '-') || '/' || key_hint
     from public.openai_credential_status(p_user)),
    'none'
  );
$$;

create function pg_temp.pending() returns text language sql as $$
  select coalesce(string_agg(right(p.workspace_id::text, 2), ',' order by p.workspace_id), '')
  from public.list_pending_push_workspaces(100) as p
  where p.workspace_id::text like '22222222-%';
$$;

-- Schema and privileges -------------------------------------------------------------

select has_table('public', 'openai_credentials', 'openai_credentials exists');
select has_table('public', 'openai_key_attempts', 'openai_key_attempts exists');
select has_column('public', 'ai_usage', 'openai_credential_id', 'ai_usage has openai_credential_id');
select ok(
  (select bool_and(c.relrowsecurity) from pg_class as c
   where c.oid in ('public.openai_credentials'::regclass, 'public.openai_key_attempts'::regclass)),
  'RLS is enabled on both tables'
);
select is(
  (select count(*) from pg_policies where schemaname = 'public' and tablename in ('openai_credentials', 'openai_key_attempts')),
  0::bigint,
  'neither table has a policy'
);
select ok(
  not (
    has_table_privilege('authenticated', 'public.openai_credentials', 'SELECT')
    or has_table_privilege('authenticated', 'public.openai_credentials', 'INSERT')
    or has_table_privilege('authenticated', 'public.openai_credentials', 'UPDATE')
    or has_table_privilege('authenticated', 'public.openai_credentials', 'DELETE')
    or has_table_privilege('anon', 'public.openai_credentials', 'SELECT')
    or has_table_privilege('anon', 'public.openai_credentials', 'INSERT')
    or has_table_privilege('authenticated', 'public.openai_key_attempts', 'SELECT')
    or has_table_privilege('authenticated', 'public.openai_key_attempts', 'INSERT')
    or has_table_privilege('anon', 'public.openai_key_attempts', 'SELECT')
  ),
  'clients have no privileges on either table'
);
select ok(
  not (
    has_function_privilege('authenticated', 'public.upsert_openai_credential(uuid, uuid, bytea, bytea, smallint, text)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.mark_openai_credential_status(uuid, uuid, public.openai_credential_status, text)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.delete_openai_credential(uuid)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.openai_credential_status(uuid)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.reserve_openai_key_attempt(uuid, integer, interval)', 'EXECUTE')
    or has_function_privilege('anon', 'public.upsert_openai_credential(uuid, uuid, bytea, bytea, smallint, text)', 'EXECUTE')
    or has_function_privilege('anon', 'public.openai_credential_status(uuid)', 'EXECUTE')
  ),
  'credential functions are not callable by anon or authenticated'
);
select ok(
  has_function_privilege('service_role', 'public.upsert_openai_credential(uuid, uuid, bytea, bytea, smallint, text)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.mark_openai_credential_status(uuid, uuid, public.openai_credential_status, text)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.delete_openai_credential(uuid)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.openai_credential_status(uuid)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.reserve_openai_key_attempt(uuid, integer, interval)', 'EXECUTE'),
  'service_role can execute the credential functions'
);
select ok(
  not (select bool_or(prosecdef) from pg_proc where proname in (
    'upsert_openai_credential', 'mark_openai_credential_status', 'delete_openai_credential',
    'openai_credential_status', 'reserve_openai_key_attempt'
  )),
  'credential functions are security invoker'
);

-- upsert, status, compare-and-set ---------------------------------------------------

set local role service_role;

select is(pg_temp.state(pg_temp.kim()), 'none', 'no status before a key is saved');
select lives_ok(
  $$select pg_temp.save(pg_temp.kim(), '22222222-0000-4000-8000-0000000004a1', 'sk-...aaaa')$$,
  'a validated key is stored'
);
select is(pg_temp.state(pg_temp.kim()), 'valid/-/sk-...aaaa', 'a stored key starts valid');
select isnt(
  (select validated_at from public.openai_credential_status(pg_temp.kim())),
  null,
  'a stored key records when it was validated'
);
select throws_ok(
  $$select public.upsert_openai_credential(
    '22222222-0000-4000-8000-00000000000a', gen_random_uuid(), extensions.gen_random_bytes(48),
    extensions.gen_random_bytes(12), 1::smallint, 'sk-proj-full-key-value')$$,
  '23514', null, 'a hint longer than the last four characters is rejected'
);
select throws_ok(
  $$select public.upsert_openai_credential(
    '22222222-0000-4000-8000-00000000000a', gen_random_uuid(), extensions.gen_random_bytes(48),
    extensions.gen_random_bytes(8), 1::smallint, 'sk-...aaaa')$$,
  '23514', null, 'an IV that is not 12 bytes is rejected'
);

select is(
  public.mark_openai_credential_status(pg_temp.kim(), '22222222-0000-4000-8000-0000000004a1', 'quota_exhausted', 'insufficient_quota'),
  true,
  'marking the current credential changes it'
);
select is(pg_temp.state(pg_temp.kim()), 'quota_exhausted/insufficient_quota/sk-...aaaa', 'the status and code are stored');
select throws_ok(
  $$select public.mark_openai_credential_status('22222222-0000-4000-8000-00000000000a', '22222222-0000-4000-8000-0000000004a1', 'invalid', null)$$,
  '23514', null, 'an unusable status requires an error code'
);

select pg_temp.save(pg_temp.kim(), '22222222-0000-4000-8000-0000000004a2', 'sk-...bbbb');
select is(pg_temp.state(pg_temp.kim()), 'valid/-/sk-...bbbb', 'a replacement is valid and clears the old error');
select is(
  (select count(*) from public.openai_credentials where user_id = pg_temp.kim()),
  1::bigint,
  'a replacement keeps one row per user'
);
select is(
  public.mark_openai_credential_status(pg_temp.kim(), '22222222-0000-4000-8000-0000000004a1', 'invalid', 'invalid_api_key'),
  false,
  'a stale credential id is ignored'
);
select is(pg_temp.state(pg_temp.kim()), 'valid/-/sk-...bbbb', 'the replaced key is unaffected by the stale write');

-- list_pending_push_workspaces --------------------------------------------------------

select is(pg_temp.pending(), 'a0', 'only owners with a valid key have pending pushes listed');
select public.mark_openai_credential_status(pg_temp.kim(), '22222222-0000-4000-8000-0000000004a2', 'invalid', 'invalid_api_key');
select is(pg_temp.pending(), '', 'an invalid key keeps the push pending but unlisted');
select public.mark_openai_credential_status(pg_temp.kim(), '22222222-0000-4000-8000-0000000004a2', 'valid', null);
select is(pg_temp.pending(), 'a0', 'a revalidated key lists the push again');

-- reserve_openai_key_attempt ----------------------------------------------------------

select is(
  (select array_agg(public.reserve_openai_key_attempt(pg_temp.lee(), 2, interval '10 minutes')) from generate_series(1, 3)),
  array[true, true, false],
  'attempts past the limit in the window are refused'
);
select is(
  public.reserve_openai_key_attempt(pg_temp.kim(), 2, interval '10 minutes'),
  true,
  'the limit is per user'
);
reset role;
update public.openai_key_attempts set attempted_at = now() - interval '11 minutes' where user_id = pg_temp.lee();
set local role service_role;
select is(
  public.reserve_openai_key_attempt(pg_temp.lee(), 2, interval '10 minutes'),
  true,
  'attempts outside the window no longer count'
);
select is(
  (select count(*) from public.openai_key_attempts where user_id = pg_temp.lee()),
  1::bigint,
  'expired attempts are pruned'
);
select throws_ok(
  $$select public.reserve_openai_key_attempt('22222222-0000-4000-8000-00000000000b', 0, interval '1 minute')$$,
  '22023', 'invalid_attempt_limit', 'a non-positive limit is rejected'
);

-- delete ----------------------------------------------------------------------------

select is(public.delete_openai_credential(pg_temp.lee()), false, 'deleting a missing key reports nothing deleted');

reset role;

-- Clients cannot see their own row ------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', pg_temp.kim(), 'role', 'authenticated')::text, true);
select throws_ok(
  $$select ciphertext from public.openai_credentials where user_id = '22222222-0000-4000-8000-00000000000a'$$,
  '42501', null, 'an authenticated user cannot read their own credential'
);
select throws_ok(
  $$delete from public.openai_credentials where user_id = '22222222-0000-4000-8000-00000000000a'$$,
  '42501', null, 'an authenticated user cannot delete their credential directly'
);
reset role;

-- ai_usage stays append-only with the new column -------------------------------------------

set local role service_role;
insert into public.ai_usage (user_id, workspace_id, task, model, source, idempotency_key, openai_credential_id)
values (pg_temp.kim(), '22222222-0000-4000-8000-0000000003a0', 'deep_analysis', 'gpt-test', 'provider', 'byok-usage-1',
  '22222222-0000-4000-8000-0000000004a1');
insert into public.ai_usage (user_id, workspace_id, task, model, source, idempotency_key)
values
  (pg_temp.kim(), '22222222-0000-4000-8000-0000000003a0', 'deep_analysis', 'gpt-test', 'provider', 'byok-usage-2'),
  (pg_temp.lee(), '22222222-0000-4000-8000-0000000003b0', 'deep_analysis', 'gpt-test', 'provider', 'byok-usage-3');
reset role;
select is(
  (select openai_credential_id from public.ai_usage where idempotency_key = 'byok-usage-1'),
  '22222222-0000-4000-8000-0000000004a1'::uuid,
  'an explicit credential id is kept'
);
select is(
  (select openai_credential_id from public.ai_usage where idempotency_key = 'byok-usage-2'),
  '22222222-0000-4000-8000-0000000004a2'::uuid,
  'a row without a credential id is attributed to the owner''s current key'
);
select is(
  (select openai_credential_id from public.ai_usage where idempotency_key = 'byok-usage-3'),
  null,
  'a row for an owner with no key stays unattributed'
);
select throws_ok(
  $$update public.ai_usage set openai_credential_id = null where idempotency_key = 'byok-usage-1'$$,
  null, null, 'ai_usage rows still cannot be updated'
);

-- Cascade -------------------------------------------------------------------------------

select pg_temp.save(pg_temp.lee(), '22222222-0000-4000-8000-0000000004b1', 'sk-...cccc');
delete from auth.users where id = pg_temp.lee();
select is(
  (select count(*) from public.openai_credentials where user_id = pg_temp.lee())
    + (select count(*) from public.openai_key_attempts where user_id = pg_temp.lee()),
  0::bigint,
  'deleting the user deletes their key and attempts'
);

select * from finish();

rollback;
