-- POST /interviews/:id/pause and POST /interviews/:id/resume: candidate-initiated pause (PRD
-- section 21). At most 3 pauses per interview; a paused interview must be resumed within 1 hour,
-- otherwise it is terminated as `user_abandoned` the next time a resume is attempted.
--
-- Pausing closes any open voice segment on the server, so voice time stops even if the browser
-- never reports its own `disconnected`. While paused, tool calls, integrity frames, and new voice
-- sessions are refused (they all require `in_progress`).
--
-- Both take the per-interview interview_events advisory lock shared by every event writer.

alter table public.interviews
  add column paused_at timestamptz,
  add column pause_count smallint not null default 0 check (pause_count between 0 and 3),
  add constraint interviews_paused_at_check check ((status = 'paused') = (paused_at is not null));

-- pause_interview -------------------------------------------------------------------------
-- Returns (status, pause_count, paused_at, disconnected_sequence) where status is one of:
--   paused          the interview is now paused
--   already_paused  it was already paused; nothing was written
--   limit_reached   it has already been paused 3 times
--   not_active      it is not in progress
-- disconnected_sequence is the sequence of the `disconnected` written to close an open voice
-- segment, or null if none was open.

create function public.pause_interview(
  p_interview_id uuid,
  p_user_id uuid
)
returns table (status text, pause_count integer, paused_at timestamptz, disconnected_sequence integer)
language plpgsql
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_interview public.interviews;
  v_voice public.event_type;
  v_sequence integer;
  v_disconnected integer;
begin
  perform pg_advisory_xact_lock(hashtext('interview_events'), hashtext(p_interview_id::text));

  select * into v_interview
  from public.interviews as i
  where i.id = p_interview_id and i.user_id = p_user_id
  for update;

  if not found then
    return query select 'not_active'::text, 0, null::timestamptz, null::integer;
    return;
  end if;

  if v_interview.status = 'paused' then
    return query select 'already_paused'::text, v_interview.pause_count::integer, v_interview.paused_at, null::integer;
    return;
  end if;

  if v_interview.status <> 'in_progress' then
    return query select 'not_active'::text, v_interview.pause_count::integer, null::timestamptz, null::integer;
    return;
  end if;

  if v_interview.pause_count >= 3 then
    return query select 'limit_reached'::text, v_interview.pause_count::integer, null::timestamptz, null::integer;
    return;
  end if;

  select coalesce(max(e.sequence), 0) + 1 into v_sequence
  from public.interview_events as e
  where e.interview_id = p_interview_id;

  select e.event_type into v_voice
  from public.interview_events as e
  where e.interview_id = p_interview_id
    and e.event_type in ('connected', 'disconnected')
  order by e.sequence desc
  limit 1;

  if v_voice = 'connected' then
    insert into public.interview_events (interview_id, user_id, sequence, event_type, payload)
    values (p_interview_id, p_user_id, v_sequence, 'disconnected', '{"source": "pause"}'::jsonb);
    v_disconnected := v_sequence;
    v_sequence := v_sequence + 1;
  end if;

  insert into public.interview_events (interview_id, user_id, sequence, event_type, payload)
  values (p_interview_id, p_user_id, v_sequence, 'pause', '{"reason": "user"}'::jsonb);

  update public.interviews as i
  set status = 'paused',
      paused_at = now(),
      pause_count = i.pause_count + 1,
      last_active_at = now()
  where i.id = p_interview_id
  returning * into v_interview;

  return query select 'paused'::text, v_interview.pause_count::integer, v_interview.paused_at, v_disconnected;
end;
$$;

revoke execute on function public.pause_interview(uuid, uuid) from public, anon, authenticated;
grant execute on function public.pause_interview(uuid, uuid) to service_role;

-- resume_interview ------------------------------------------------------------------------
-- Returns status, one of:
--   resumed         the interview is back in progress
--   already_active  it was already in progress; nothing was written
--   expired         the 1-hour window passed; it is now terminated as `user_abandoned`
--   not_active      it is neither paused nor in progress

create function public.resume_interview(
  p_interview_id uuid,
  p_user_id uuid
)
returns table (status text)
language plpgsql
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_window constant interval := interval '1 hour';
  v_interview public.interviews;
  v_sequence integer;
begin
  perform pg_advisory_xact_lock(hashtext('interview_events'), hashtext(p_interview_id::text));

  select * into v_interview
  from public.interviews as i
  where i.id = p_interview_id and i.user_id = p_user_id
  for update;

  if not found then
    return query select 'not_active'::text;
    return;
  end if;

  if v_interview.status = 'in_progress' then
    return query select 'already_active'::text;
    return;
  end if;

  if v_interview.status <> 'paused' then
    return query select 'not_active'::text;
    return;
  end if;

  select coalesce(max(e.sequence), 0) + 1 into v_sequence
  from public.interview_events as e
  where e.interview_id = p_interview_id;

  if v_interview.paused_at + v_window < now() then
    update public.interviews as i
    set status = 'terminated',
        termination_reason = 'user_abandoned',
        paused_at = null,
        ended_at = now()
    where i.id = p_interview_id;

    insert into public.interview_events (interview_id, user_id, sequence, event_type, payload)
    values (p_interview_id, p_user_id, v_sequence, 'termination', '{"reason": "user_abandoned"}'::jsonb);

    return query select 'expired'::text;
    return;
  end if;

  update public.interviews as i
  set status = 'in_progress',
      paused_at = null,
      last_active_at = now()
  where i.id = p_interview_id;

  insert into public.interview_events (interview_id, user_id, sequence, event_type, payload)
  values (p_interview_id, p_user_id, v_sequence, 'resume', '{"reason": "user"}'::jsonb);

  return query select 'resumed'::text;
end;
$$;

revoke execute on function public.resume_interview(uuid, uuid) from public, anon, authenticated;
grant execute on function public.resume_interview(uuid, uuid) to service_role;
