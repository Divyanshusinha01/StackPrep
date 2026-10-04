-- Interviews, hidden interview state, and append-only message/event history
-- (architecture section 9). Text transcript only; no audio is persisted (PRD section 22).

-- interviews ----------------------------------------------------------------
-- Holds no hidden state; safe to expose in full to the owner.

create table public.interviews (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  user_id uuid not null,
  interview_number integer not null check (interview_number >= 1),
  repository_commit_sha public.git_commit_sha not null,
  status public.interview_status not null default 'created',
  termination_reason public.termination_reason,
  termination_detail text,
  integrity_warning_count smallint not null default 0 check (integrity_warning_count between 0 and 3),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  ended_at timestamptz,
  last_active_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (workspace_id, interview_number),
  unique (id, user_id),
  unique (id, workspace_id, user_id),
  foreign key (workspace_id, user_id)
    references public.workspaces (id, user_id)
    on delete cascade,
  check (termination_reason is null or status in ('terminated', 'completed')),
  check (status <> 'terminated' or termination_reason is not null),
  check (termination_detail is null or termination_reason is not null)
);

create index interviews_user_id_idx on public.interviews (user_id);
create index interviews_workspace_id_user_id_idx on public.interviews (workspace_id, user_id);

create trigger interviews_set_updated_at
  before update on public.interviews
  for each row execute function public.set_updated_at();

-- interview_state -----------------------------------------------------------
-- Hidden "current state for fast reads". Never granted to clients (see RLS migration).
-- version is only ever bumped by update_interview_state().

create table public.interview_state (
  interview_id uuid primary key references public.interviews (id) on delete cascade,
  coverage_map jsonb not null default '{}'::jsonb,
  plan jsonb not null default '{}'::jsonb,
  strategy jsonb not null default '{}'::jsonb,
  version bigint not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create function public.prevent_interview_state_repoint()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.interview_id is distinct from old.interview_id then
    raise exception using
      errcode = '42501',
      message = 'interview_state.interview_id cannot be changed';
  end if;
  return new;
end;
$$;

create trigger interview_state_prevent_repoint
  before update of interview_id on public.interview_state
  for each row execute function public.prevent_interview_state_repoint();

-- Every committed interview has exactly one state row, enforced at commit time regardless
-- of which code path inserted it. Security definer so RLS never hides rows from the check.
create function public.assert_interview_has_state()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.interviews where id = new.id)
     and not exists (select 1 from public.interview_state where interview_id = new.id) then
    raise exception using
      errcode = '23514',
      message = 'interview_missing_state',
      detail = format('Interview %s was inserted without an interview_state row.', new.id);
  end if;
  return null;
end;
$$;

create constraint trigger interviews_require_state
  after insert on public.interviews
  deferrable initially deferred
  for each row execute function public.assert_interview_has_state();

-- State can only disappear together with its interview (cascade).
create function public.assert_interview_state_parent_deleted()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.interviews where id = old.interview_id) then
    raise exception using
      errcode = '23514',
      message = 'interview_state_delete_forbidden',
      detail = format('interview_state for interview %s cannot be deleted while the interview exists.', old.interview_id);
  end if;
  return null;
end;
$$;

create constraint trigger interview_state_requires_parent_deleted
  after delete on public.interview_state
  deferrable initially deferred
  for each row execute function public.assert_interview_state_parent_deleted();

-- create_interview ----------------------------------------------------------
-- PostgREST runs each request in its own transaction, so creating the interview and its
-- state atomically requires a single database function.

create function public.create_interview(
  p_workspace_id uuid,
  p_user_id uuid,
  p_repository_commit_sha text,
  p_coverage_map jsonb,
  p_plan jsonb,
  p_strategy jsonb
)
returns public.interviews
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_owner uuid;
  v_number integer;
  v_interview public.interviews;
begin
  -- Row lock serializes interview_number assignment per workspace.
  select w.user_id into v_owner
  from public.workspaces as w
  where w.id = p_workspace_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'workspace_not_found';
  end if;

  if v_owner is distinct from p_user_id then
    raise exception using errcode = '42501', message = 'workspace_not_owned';
  end if;

  select coalesce(max(i.interview_number), 0) + 1 into v_number
  from public.interviews as i
  where i.workspace_id = p_workspace_id;

  insert into public.interviews (workspace_id, user_id, interview_number, repository_commit_sha)
  values (p_workspace_id, p_user_id, v_number, p_repository_commit_sha)
  returning * into v_interview;

  insert into public.interview_state (interview_id, coverage_map, plan, strategy, version)
  values (
    v_interview.id,
    coalesce(p_coverage_map, '{}'::jsonb),
    coalesce(p_plan, '{}'::jsonb),
    coalesce(p_strategy, '{}'::jsonb),
    1
  );

  return v_interview;
end;
$$;

revoke execute on function public.create_interview(uuid, uuid, text, jsonb, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.create_interview(uuid, uuid, text, jsonb, jsonb, jsonb)
  to service_role;

-- update_interview_state ----------------------------------------------------
-- Optimistic concurrency: succeeds only if the caller's expected version is current.
-- A stale or unknown interview raises SQLSTATE P0409 (stale_interview_state).

create function public.update_interview_state(
  p_interview_id uuid,
  p_expected_version bigint,
  p_coverage_map jsonb,
  p_plan jsonb,
  p_strategy jsonb
)
returns bigint
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_new_version bigint;
  v_row_count bigint;
begin
  update public.interview_state
  set coverage_map = p_coverage_map,
      plan = p_plan,
      strategy = p_strategy,
      version = version + 1,
      updated_at = now()
  where interview_id = p_interview_id
    and version = p_expected_version
  returning version into v_new_version;

  get diagnostics v_row_count = row_count;

  if v_row_count = 0 then
    raise exception using
      errcode = 'P0409',
      message = 'stale_interview_state',
      detail = format('No interview_state for interview %s at version %s.', p_interview_id, p_expected_version);
  end if;

  if v_row_count <> 1 then
    raise exception using
      errcode = 'P0001',
      message = format('update_interview_state affected %s rows', v_row_count);
  end if;

  return v_new_version;
end;
$$;

revoke execute on function public.update_interview_state(uuid, bigint, jsonb, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.update_interview_state(uuid, bigint, jsonb, jsonb, jsonb)
  to service_role;

-- Append-only history -------------------------------------------------------
-- Updates are rejected for every role. Deletes are only allowed for the service role and
-- the table owner (which is the role that runs ON DELETE CASCADE from interviews).

create function public.enforce_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception using
      errcode = '42501',
      message = format('%I is append-only', tg_table_name);
  end if;

  if current_user not in ('postgres', 'supabase_admin', 'service_role') then
    raise exception using
      errcode = '42501',
      message = format('%I rows cannot be deleted', tg_table_name);
  end if;

  return old;
end;
$$;

-- interview_messages --------------------------------------------------------

create table public.interview_messages (
  id uuid primary key default gen_random_uuid(),
  interview_id uuid not null,
  user_id uuid not null,
  sequence integer not null check (sequence >= 1),
  role public.message_role not null,
  content text not null,
  -- For answers: the question message being answered.
  question_message_id uuid,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  unique (interview_id, sequence),
  unique (id, interview_id),
  foreign key (interview_id, user_id)
    references public.interviews (id, user_id)
    on delete cascade,
  foreign key (question_message_id, interview_id)
    references public.interview_messages (id, interview_id)
    on delete cascade,
  check (question_message_id is null or question_message_id <> id)
);

create index interview_messages_user_id_idx on public.interview_messages (user_id);
create index interview_messages_interview_user_idx on public.interview_messages (interview_id, user_id);
create index interview_messages_question_idx
  on public.interview_messages (question_message_id, interview_id)
  where question_message_id is not null;

create trigger interview_messages_append_only
  before update or delete on public.interview_messages
  for each row execute function public.enforce_append_only();

-- interview_events ----------------------------------------------------------

create table public.interview_events (
  id uuid primary key default gen_random_uuid(),
  interview_id uuid not null,
  user_id uuid not null,
  sequence integer not null check (sequence >= 1),
  event_type public.event_type not null,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (interview_id, sequence),
  foreign key (interview_id, user_id)
    references public.interviews (id, user_id)
    on delete cascade
);

create index interview_events_user_id_idx on public.interview_events (user_id);
create index interview_events_interview_user_idx on public.interview_events (interview_id, user_id);

create trigger interview_events_append_only
  before update or delete on public.interview_events
  for each row execute function public.enforce_append_only();

revoke execute on function public.prevent_interview_state_repoint() from public, anon, authenticated;
revoke execute on function public.assert_interview_has_state() from public, anon, authenticated;
revoke execute on function public.assert_interview_state_parent_deleted() from public, anon, authenticated;
revoke execute on function public.enforce_append_only() from public, anon, authenticated;
