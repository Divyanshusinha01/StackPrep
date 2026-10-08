-- POST /interviews/:id/end: the candidate ends the interview early and gets a report from the
-- answers so far (PRD section 21). Works from in_progress and paused. With no evaluated answer
-- there is nothing to report on, so the interview is terminated as `user_abandoned` instead.
--
-- Takes the per-interview interview_events advisory lock shared by every event writer.

-- end_interview_by_user ---------------------------------------------------------------------
-- Returns (status, disconnected_sequence) where status is one of:
--   completed           now completed as `user_ended`; a report should be queued
--   no_report           no evaluated answer, so now terminated as `user_abandoned`
--   already_completed   it was already completed; nothing was written
--   already_terminated  it was already terminated as `user_abandoned`; nothing was written
--   not_active          it never started, or ended some other way
-- disconnected_sequence is the sequence of the `disconnected` written to close an open voice
-- segment, or null if none was open.

create function public.end_interview_by_user(
  p_interview_id uuid,
  p_user_id uuid
)
returns table (status text, disconnected_sequence integer)
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
    return query select 'not_active'::text, null::integer;
    return;
  end if;

  if v_interview.status = 'completed' then
    return query select 'already_completed'::text, null::integer;
    return;
  end if;

  if v_interview.status = 'terminated' and v_interview.termination_reason = 'user_abandoned' then
    return query select 'already_terminated'::text, null::integer;
    return;
  end if;

  if v_interview.status not in ('in_progress', 'paused') then
    return query select 'not_active'::text, null::integer;
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
    values (p_interview_id, p_user_id, v_sequence, 'disconnected', '{"source": "user_end"}'::jsonb);
    v_disconnected := v_sequence;
    v_sequence := v_sequence + 1;
  end if;

  if not exists (select 1 from public.evaluations as ev where ev.interview_id = p_interview_id) then
    update public.interviews as i
    set status = 'terminated',
        termination_reason = 'user_abandoned',
        paused_at = null,
        ended_at = now(),
        last_active_at = now()
    where i.id = p_interview_id;

    insert into public.interview_events (interview_id, user_id, sequence, event_type, payload)
    values (p_interview_id, p_user_id, v_sequence, 'termination', '{"reason": "user_abandoned", "source": "user_end"}'::jsonb);

    return query select 'no_report'::text, v_disconnected;
    return;
  end if;

  update public.interviews as i
  set status = 'completed',
      termination_reason = 'user_ended',
      paused_at = null,
      ended_at = now(),
      last_active_at = now()
  where i.id = p_interview_id;

  insert into public.interview_events (interview_id, user_id, sequence, event_type, payload)
  values (p_interview_id, p_user_id, v_sequence, 'completion', '{"reason": "user_ended"}'::jsonb);

  return query select 'completed'::text, v_disconnected;
end;
$$;

revoke execute on function public.end_interview_by_user(uuid, uuid) from public, anon, authenticated;
grant execute on function public.end_interview_by_user(uuid, uuid) to service_role;
