-- DELETE /interviews/:id now works in every status (PRD section 28). A pending, in-progress or
-- paused interview is first terminated as `user_abandoned` with no report, closing an open voice
-- segment the same way end_interview_by_user does, and then marked deleted.

drop function public.delete_interview(uuid, uuid);

-- delete_interview ---------------------------------------------------------------------------
-- Returns (status, disconnected_sequence) where status is one of:
--   deleted          deleted_at is now set
--   already_deleted  it was already deleted; nothing was written
--   not_found        no interview with this id belongs to the user
-- disconnected_sequence is the sequence of the `disconnected` written to close an open voice
-- segment, or null if none was open.
--
-- Takes the per-interview interview_events advisory lock shared by every event writer, so it
-- cannot interleave with a start, end or pause of the same interview.

create function public.delete_interview(
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
    return query select 'not_found'::text, null::integer;
    return;
  end if;

  if v_interview.deleted_at is not null then
    return query select 'already_deleted'::text, null::integer;
    return;
  end if;

  if v_interview.status in ('created', 'in_progress', 'paused') then
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
      values (p_interview_id, p_user_id, v_sequence, 'disconnected', '{"source": "user_delete"}'::jsonb);
      v_disconnected := v_sequence;
      v_sequence := v_sequence + 1;
    end if;

    update public.interviews as i
    set status = 'terminated',
        termination_reason = 'user_abandoned',
        paused_at = null,
        ended_at = now(),
        last_active_at = now()
    where i.id = p_interview_id;

    insert into public.interview_events (interview_id, user_id, sequence, event_type, payload)
    values (p_interview_id, p_user_id, v_sequence, 'termination', '{"reason": "user_abandoned", "source": "user_delete"}'::jsonb);
  end if;

  update public.interviews as i
  set deleted_at = now()
  where i.id = p_interview_id;

  return query select 'deleted'::text, v_disconnected;
end;
$$;

revoke execute on function public.delete_interview(uuid, uuid) from public, anon, authenticated;
grant execute on function public.delete_interview(uuid, uuid) to service_role;
