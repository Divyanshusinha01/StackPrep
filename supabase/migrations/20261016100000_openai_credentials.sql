-- Account-level OpenAI keys (bring your own key). Each user stores one key that serves all of their
-- workspaces; every AI call runs on the owner's key and StackPrep never funds usage.
--
-- The key is encrypted in Edge Functions (AES-256-GCM, additional data bound to the user and the
-- credential id) with a versioned master key held only in function secrets. The database stores
-- ciphertext, never the key or the master key. Service role only: no client grants or policies;
-- the web app reads status through the `me` function.

create type public.openai_credential_status as enum ('valid', 'invalid', 'quota_exhausted', 'permission_denied');

-- openai_credentials ---------------------------------------------------------------
-- credential_id changes on every replacement, so a status written by a job that resolved an older
-- key never applies to the new one (mark_openai_credential_status compares it).

create table public.openai_credentials (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  credential_id uuid not null unique,
  ciphertext bytea not null check (octet_length(ciphertext) between 17 and 1024),
  iv bytea not null check (octet_length(iv) = 12),
  enc_key_version smallint not null check (enc_key_version > 0),
  key_hint text not null check (key_hint ~ '^sk-\.\.\.[A-Za-z0-9_-]{4}$'),
  status public.openai_credential_status not null default 'valid',
  validated_at timestamptz,
  last_error_code text check (
    last_error_code in ('invalid_api_key', 'insufficient_quota', 'permission_denied', 'model_unavailable')
  ),
  last_error_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'valid') = (last_error_code is null))
);

create trigger openai_credentials_set_updated_at
  before update on public.openai_credentials
  for each row execute function public.set_updated_at();

alter table public.openai_credentials enable row level security;

revoke all on public.openai_credentials from anon, authenticated;
grant select, insert, update, delete on public.openai_credentials to service_role;

-- openai_key_attempts -----------------------------------------------------------------
-- Every save or re-validation calls OpenAI with a candidate key; attempts are rate limited per user.

create table public.openai_key_attempts (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  attempted_at timestamptz not null default now()
);

create index openai_key_attempts_user_idx on public.openai_key_attempts (user_id, attempted_at);

alter table public.openai_key_attempts enable row level security;

revoke all on public.openai_key_attempts from anon, authenticated;
grant select, insert, delete on public.openai_key_attempts to service_role;

-- reserve_openai_key_attempt ------------------------------------------------------------
-- Reserves one attempt when fewer than p_max were made in the trailing p_window. Expired rows of the
-- user are pruned. Serialized per user, so concurrent requests cannot both take the last slot.

create function public.reserve_openai_key_attempt(
  p_user_id uuid,
  p_max integer,
  p_window interval
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_max is null or p_max < 1 or p_window is null or p_window <= interval '0' then
    raise exception using errcode = '22023', message = 'invalid_attempt_limit';
  end if;

  perform pg_advisory_xact_lock(hashtext('openai_key_attempts'), hashtext(p_user_id::text));

  delete from public.openai_key_attempts as a
  where a.user_id = p_user_id and a.attempted_at <= now() - p_window;

  if (select count(*) from public.openai_key_attempts as a where a.user_id = p_user_id) >= p_max then
    return false;
  end if;

  insert into public.openai_key_attempts (user_id) values (p_user_id);
  return true;
end;
$$;

-- upsert_openai_credential --------------------------------------------------------------
-- Stores a key that has just passed validation, replacing any previous one. Called only after
-- validation succeeds, so a rejected replacement leaves the previous key in place.

create function public.upsert_openai_credential(
  p_user_id uuid,
  p_credential_id uuid,
  p_ciphertext bytea,
  p_iv bytea,
  p_enc_key_version smallint,
  p_key_hint text
)
returns void
language sql
security invoker
set search_path = ''
as $$
  insert into public.openai_credentials as c (
    user_id, credential_id, ciphertext, iv, enc_key_version, key_hint, status, validated_at,
    last_error_code, last_error_at
  )
  values (p_user_id, p_credential_id, p_ciphertext, p_iv, p_enc_key_version, p_key_hint, 'valid', now(), null, null)
  on conflict (user_id) do update
  set credential_id = excluded.credential_id,
      ciphertext = excluded.ciphertext,
      iv = excluded.iv,
      enc_key_version = excluded.enc_key_version,
      key_hint = excluded.key_hint,
      status = 'valid',
      validated_at = excluded.validated_at,
      last_error_code = null,
      last_error_at = null;
$$;

-- mark_openai_credential_status ----------------------------------------------------------
-- Compare-and-set on credential_id: only the key the caller resolved is changed. `valid` records a
-- successful validation; any other status records p_error_code. Returns true when a row changed.

create function public.mark_openai_credential_status(
  p_user_id uuid,
  p_credential_id uuid,
  p_status public.openai_credential_status,
  p_error_code text
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.openai_credentials as c
  set status = p_status,
      validated_at = case when p_status = 'valid' then now() else c.validated_at end,
      last_error_code = case when p_status = 'valid' then null else p_error_code end,
      last_error_at = case when p_status = 'valid' then c.last_error_at else now() end
  where c.user_id = p_user_id and c.credential_id = p_credential_id;
  return found;
end;
$$;

-- delete_openai_credential ---------------------------------------------------------------

create function public.delete_openai_credential(p_user_id uuid)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  delete from public.openai_credentials as c where c.user_id = p_user_id;
  return found;
end;
$$;

-- openai_credential_status ---------------------------------------------------------------
-- Status columns only; never the ciphertext. No row when the user has no key.

create function public.openai_credential_status(p_user_id uuid)
returns table (
  status public.openai_credential_status,
  key_hint text,
  validated_at timestamptz,
  last_error_code text
)
language sql
stable
security invoker
set search_path = ''
as $$
  select c.status, c.key_hint, c.validated_at, c.last_error_code
  from public.openai_credentials as c
  where c.user_id = p_user_id;
$$;

-- ai_usage ----------------------------------------------------------------------------
-- The credential whose key paid for the call. No foreign key: credentials are replaced and deleted
-- while ai_usage is append-only. Null for rows written before BYOK.

alter table public.ai_usage add column openai_credential_id uuid;

-- Rows written without an explicit credential (client-reported voice usage, duration estimates)
-- are attributed to the owner's credential at write time; approximate if the key changed mid-session.
create function public.ai_usage_default_credential()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.openai_credential_id is null then
    select c.credential_id into new.openai_credential_id
    from public.openai_credentials as c
    where c.user_id = new.user_id;
  end if;
  return new;
end;
$$;

revoke execute on function public.ai_usage_default_credential() from public, anon, authenticated;

create trigger ai_usage_default_credential
before insert on public.ai_usage
for each row execute function public.ai_usage_default_credential();

-- tool_call_metrics -------------------------------------------------------------------
-- search_repository skips the vector fill when the owner's key cannot be used.

alter table public.tool_call_metrics drop constraint tool_call_metrics_vector_fallback_reason_check;
alter table public.tool_call_metrics add constraint tool_call_metrics_vector_fallback_reason_check check (
  vector_fallback_reason in ('deadline', 'embed_error', 'rpc_error', 'no_results', 'disabled', 'key_unavailable')
);

-- list_pending_push_workspaces ------------------------------------------------------
-- Now also requires the owner to have a valid OpenAI key: a push for an owner without one stays
-- pending (push_generation > synced_generation) and is listed again once a key is saved.

create or replace function public.list_pending_push_workspaces(p_limit integer default 100)
returns table (workspace_id uuid, installation_id bigint, push_generation bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  select w.id, c.installation_id, w.push_generation
  from public.workspaces as w
  join public.repositories as r on r.id = w.repository_id and r.user_id = w.user_id
  join public.github_connections as c on c.id = r.github_connection_id and c.user_id = r.user_id
  join public.openai_credentials as k on k.user_id = w.user_id and k.status = 'valid'
  where w.status = 'ready'
    and w.push_generation > w.synced_generation
    and c.suspended_at is null
    and not exists (
      select 1 from public.jobs as j
      where j.workspace_id = w.id
        and j.type in ('repository_indexing', 'deep_analysis', 'code_indexing')
        and j.status in ('queued', 'running')
    )
  order by w.updated_at, w.id
  limit least(greatest(coalesce(p_limit, 100), 1), 500);
$$;

-- Grants --------------------------------------------------------------------

revoke execute on function public.reserve_openai_key_attempt(uuid, integer, interval) from public, anon, authenticated;
grant execute on function public.reserve_openai_key_attempt(uuid, integer, interval) to service_role;

revoke execute on function public.upsert_openai_credential(uuid, uuid, bytea, bytea, smallint, text) from public, anon, authenticated;
grant execute on function public.upsert_openai_credential(uuid, uuid, bytea, bytea, smallint, text) to service_role;

revoke execute on function public.mark_openai_credential_status(uuid, uuid, public.openai_credential_status, text) from public, anon, authenticated;
grant execute on function public.mark_openai_credential_status(uuid, uuid, public.openai_credential_status, text) to service_role;

revoke execute on function public.delete_openai_credential(uuid) from public, anon, authenticated;
grant execute on function public.delete_openai_credential(uuid) to service_role;

revoke execute on function public.openai_credential_status(uuid) from public, anon, authenticated;
grant execute on function public.openai_credential_status(uuid) to service_role;

revoke execute on function public.list_pending_push_workspaces(integer) from public, anon, authenticated;
grant execute on function public.list_pending_push_workspaces(integer) to service_role;
