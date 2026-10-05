-- POST /interviews/:id/tool-calls (architecture section 10): idempotent tool-call records,
-- evidence_examined events, the created -> in_progress transition on the first connection, and
-- interview completion.
--
-- Every function that writes interview_events takes the same per-interview advisory lock as
-- record_voice_event, so server-assigned sequences never collide.

-- evidence_examined ---------------------------------------------------------------
-- One event per examined path per interview, however many tools touched it.

create unique index interview_events_evidence_path_key
  on public.interview_events (interview_id, (payload ->> 'path'))
  where event_type = 'evidence_examined';

alter table public.interview_events
  add constraint interview_events_evidence_has_path
  check (event_type <> 'evidence_examined' or nullif(payload ->> 'path', '') is not null);

create index interview_events_tool_call_recent_idx
  on public.interview_events (interview_id, occurred_at)
  where event_type = 'tool_call';

-- record_evidence_examined -----------------------------------------------------------
-- p_evidence is a JSON array of {path, area?, tool}. Paths already recorded for the interview are
-- skipped. Callers must hold the interview_events advisory lock. Returns the number inserted.

create function public.record_evidence_examined(
  p_interview_id uuid,
  p_user_id uuid,
  p_evidence jsonb
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_item jsonb;
  v_path text;
  v_count integer := 0;
begin
  if p_evidence is null or jsonb_typeof(p_evidence) <> 'array' then
    return 0;
  end if;

  perform pg_advisory_xact_lock(hashtext('interview_events'), hashtext(p_interview_id::text));

  for v_item in select value from jsonb_array_elements(p_evidence) limit 20 loop
    v_path := nullif(v_item ->> 'path', '');
    if v_path is null or v_item ->> 'tool' not in ('get_file', 'search_repository') then
      continue;
    end if;
    if exists (
      select 1 from public.interview_events as e
      where e.interview_id = p_interview_id
        and e.event_type = 'evidence_examined'
        and e.payload ->> 'path' = v_path
    ) then
      continue;
    end if;

    insert into public.interview_events (interview_id, user_id, sequence, event_type, payload)
    select
      p_interview_id,
      p_user_id,
      coalesce(max(e.sequence), 0) + 1,
      'evidence_examined',
      jsonb_strip_nulls(jsonb_build_object('path', v_path, 'area', v_item ->> 'area', 'tool', v_item ->> 'tool'))
    from public.interview_events as e
    where e.interview_id = p_interview_id;

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

revoke execute on function public.record_evidence_examined(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.record_evidence_examined(uuid, uuid, jsonb) to service_role;

-- record_tool_call ---------------------------------------------------------------------
-- Stores the tool_call event, its evidence, and (for evaluate_answer) the hidden evaluation in one
-- transaction. Returns (status, sequence, result):
--   created         stored at `sequence`
--   duplicate       call_id already stored with the same tool and args; `result` is the stored
--                   result (null for read-only tools, which are re-executed instead)
--   event_conflict  call_id already used for a different tool or args
--
-- p_result is stored only for state-changing tools so a replay returns the same answer.
-- p_evaluation, when given, is one evaluations row as JSON (message_id, category, score, rating,
-- strengths, gaps, repo_evidence, discrepancy, discrepancy_detail).

create function public.record_tool_call(
  p_interview_id uuid,
  p_user_id uuid,
  p_call_id text,
  p_tool text,
  p_args jsonb,
  p_result_summary jsonb,
  p_result jsonb,
  p_evidence jsonb,
  p_evaluation jsonb
)
returns table (status text, sequence integer, result jsonb)
language plpgsql
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_existing public.interview_events;
  v_sequence integer;
begin
  if p_call_id is null or length(p_call_id) not between 1 and 128 then
    raise exception using errcode = '22023', message = 'invalid_call_id';
  end if;
  if p_tool is null or p_tool not in ('search_repository', 'get_file', 'evaluate_answer', 'advance_interview', 'end_interview') then
    raise exception using errcode = '22023', message = 'invalid_tool';
  end if;

  perform pg_advisory_xact_lock(hashtext('interview_events'), hashtext(p_interview_id::text));

  select * into v_existing
  from public.interview_events as e
  where e.interview_id = p_interview_id
    and e.event_type = 'tool_call'
    and e.payload ->> 'call_id' = p_call_id;

  if found then
    if v_existing.payload ->> 'tool' = p_tool and v_existing.payload -> 'args' = coalesce(p_args, '{}'::jsonb) then
      return query select 'duplicate'::text, v_existing.sequence, v_existing.payload -> 'result';
    else
      return query select 'event_conflict'::text, v_existing.sequence, null::jsonb;
    end if;
    return;
  end if;

  select coalesce(max(e.sequence), 0) + 1 into v_sequence
  from public.interview_events as e
  where e.interview_id = p_interview_id;

  insert into public.interview_events (interview_id, user_id, sequence, event_type, payload)
  values (
    p_interview_id,
    p_user_id,
    v_sequence,
    'tool_call',
    jsonb_strip_nulls(jsonb_build_object(
      'call_id', p_call_id,
      'tool', p_tool,
      'args', coalesce(p_args, '{}'::jsonb),
      'result_summary', coalesce(p_result_summary, '{}'::jsonb),
      'result', p_result
    ))
  );

  perform public.record_evidence_examined(p_interview_id, p_user_id, p_evidence);

  if p_evaluation is not null then
    insert into public.evaluations (
      interview_id, user_id, message_id, category, score, rating,
      strengths, gaps, repo_evidence, discrepancy, discrepancy_detail
    )
    values (
      p_interview_id,
      p_user_id,
      (p_evaluation ->> 'message_id')::uuid,
      p_evaluation ->> 'category',
      (p_evaluation ->> 'score')::smallint,
      p_evaluation ->> 'rating',
      coalesce(p_evaluation -> 'strengths', '[]'::jsonb),
      coalesce(p_evaluation -> 'gaps', '[]'::jsonb),
      coalesce(p_evaluation -> 'repo_evidence', '[]'::jsonb),
      coalesce((p_evaluation ->> 'discrepancy')::boolean, false),
      nullif(p_evaluation ->> 'discrepancy_detail', '')
    );
  end if;

  return query select 'created'::text, v_sequence, p_result;
end;
$$;

revoke execute on function public.record_tool_call(uuid, uuid, text, text, jsonb, jsonb, jsonb, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.record_tool_call(uuid, uuid, text, text, jsonb, jsonb, jsonb, jsonb, jsonb)
  to service_role;

-- complete_interview -------------------------------------------------------------------
-- in_progress -> completed plus one `completion` event, atomically. Returns false when the
-- interview was not in progress (already completed, or never started), so concurrent callers
-- complete it once. p_reason is null for a normal end and 'time_limit' at the voice cap.

create function public.complete_interview(
  p_interview_id uuid,
  p_user_id uuid,
  p_reason public.termination_reason
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_reason is not null and p_reason not in ('time_limit', 'completed_early') then
    raise exception using errcode = '22023', message = 'invalid_completion_reason';
  end if;

  perform pg_advisory_xact_lock(hashtext('interview_events'), hashtext(p_interview_id::text));

  update public.interviews
  set status = 'completed',
      termination_reason = p_reason,
      ended_at = now(),
      last_active_at = now()
  where id = p_interview_id
    and user_id = p_user_id
    and status = 'in_progress';

  if not found then
    return false;
  end if;

  insert into public.interview_events (interview_id, user_id, sequence, event_type, payload)
  select
    p_interview_id,
    p_user_id,
    coalesce(max(e.sequence), 0) + 1,
    'completion',
    jsonb_strip_nulls(jsonb_build_object('reason', p_reason))
  from public.interview_events as e
  where e.interview_id = p_interview_id;

  return true;
end;
$$;

revoke execute on function public.complete_interview(uuid, uuid, public.termination_reason)
  from public, anon, authenticated;
grant execute on function public.complete_interview(uuid, uuid, public.termination_reason)
  to service_role;

-- record_voice_event: start the interview on its first connection ----------------------
-- Same contract as before. A new `connected` on a `created` interview also moves it to
-- in_progress and writes one `start` event right after the connected event. Any stored voice event
-- refreshes last_active_at while the interview is in progress.

create or replace function public.record_voice_event(
  p_interview_id uuid,
  p_user_id uuid,
  p_client_event_id uuid,
  p_event_type public.event_type,
  p_payload jsonb
)
returns table (status text, sequence integer)
language plpgsql
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_existing public.interview_events;
  v_sequence integer;
begin
  if p_event_type not in ('connected', 'disconnected') then
    raise exception using errcode = '22023', message = 'invalid_voice_event_type';
  end if;

  -- Serializes event sequence assignment per interview.
  perform pg_advisory_xact_lock(hashtext('interview_events'), hashtext(p_interview_id::text));

  select * into v_existing
  from public.interview_events as e
  where e.interview_id = p_interview_id
    and e.client_event_id = p_client_event_id;

  if found then
    if v_existing.event_type = p_event_type then
      return query select 'duplicate'::text, v_existing.sequence;
    else
      return query select 'event_conflict'::text, v_existing.sequence;
    end if;
    return;
  end if;

  select coalesce(max(e.sequence), 0) + 1 into v_sequence
  from public.interview_events as e
  where e.interview_id = p_interview_id;

  insert into public.interview_events (interview_id, user_id, sequence, event_type, payload, client_event_id)
  values (p_interview_id, p_user_id, v_sequence, p_event_type, coalesce(p_payload, '{}'::jsonb), p_client_event_id);

  if p_event_type = 'connected' then
    update public.interviews as i
    set status = 'in_progress',
        started_at = coalesce(i.started_at, now()),
        last_active_at = now()
    where i.id = p_interview_id
      and i.user_id = p_user_id
      and i.status = 'created';

    if found then
      insert into public.interview_events (interview_id, user_id, sequence, event_type, payload)
      values (p_interview_id, p_user_id, v_sequence + 1, 'start', '{}'::jsonb);
      return query select 'created'::text, v_sequence;
      return;
    end if;
  end if;

  update public.interviews as i
  set last_active_at = now()
  where i.id = p_interview_id
    and i.status = 'in_progress';

  return query select 'created'::text, v_sequence;
end;
$$;
