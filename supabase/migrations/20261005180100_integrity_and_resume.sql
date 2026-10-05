-- POST /interviews/:id/integrity/frames (architecture section 10) and technical pause/resume
-- events (PRD section 21).
--
-- A frame check is two short transactions around the vision call, so no lock is held while the
-- model runs:
--   1. reserve_integrity_check   appends an `integrity_check` reservation, which is also the rate
--                                limit: one accepted frame per interview every 10 seconds
--   2. record_integrity_signal   resolves the reservation, with or without a signal
-- Events are append-only, so resolving appends a second event that references the reservation's
-- id (`payload.check_id`) instead of updating it. Images are never passed to or stored by either.
--
-- Both take the per-interview interview_events advisory lock shared by every event writer.

create index interview_events_integrity_check_idx
  on public.interview_events (interview_id, sequence desc)
  where event_type in ('integrity_check', 'integrity_warning');

-- reserve_integrity_check ---------------------------------------------------------------
-- Returns (status, check_id) where status is one of:
--   reserved      a reservation was stored; analyze the frame and resolve `check_id`
--   not_active    the interview is not in progress
--   interrupted   the latest voice-state event is a pause or disconnect (frames are not
--                 analyzed while the candidate is reconnecting)
--   rate_limited  a frame was accepted less than 10 seconds ago

create function public.reserve_integrity_check(
  p_interview_id uuid,
  p_user_id uuid
)
returns table (status text, check_id uuid)
language plpgsql
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_status public.interview_status;
  v_voice public.event_type;
  v_last timestamptz;
  v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext('interview_events'), hashtext(p_interview_id::text));

  select i.status into v_status
  from public.interviews as i
  where i.id = p_interview_id and i.user_id = p_user_id;

  if v_status is distinct from 'in_progress' then
    return query select 'not_active'::text, null::uuid;
    return;
  end if;

  select e.event_type into v_voice
  from public.interview_events as e
  where e.interview_id = p_interview_id
    and e.event_type in ('connected', 'disconnected', 'pause', 'resume')
  order by e.sequence desc
  limit 1;

  if v_voice is null or v_voice in ('disconnected', 'pause') then
    return query select 'interrupted'::text, null::uuid;
    return;
  end if;

  select e.occurred_at into v_last
  from public.interview_events as e
  where e.interview_id = p_interview_id
    and e.event_type = 'integrity_check'
    and not (e.payload ? 'check_id')
  order by e.sequence desc
  limit 1;

  if v_last is not null and v_last > now() - interval '10 seconds' then
    return query select 'rate_limited'::text, null::uuid;
    return;
  end if;

  insert into public.interview_events (interview_id, user_id, sequence, event_type, payload)
  select p_interview_id, p_user_id, coalesce(max(e.sequence), 0) + 1, 'integrity_check', '{"outcome": "pending"}'::jsonb
  from public.interview_events as e
  where e.interview_id = p_interview_id
  returning id into v_id;

  return query select 'reserved'::text, v_id;
end;
$$;

revoke execute on function public.reserve_integrity_check(uuid, uuid) from public, anon, authenticated;
grant execute on function public.reserve_integrity_check(uuid, uuid) to service_role;

-- record_integrity_signal ----------------------------------------------------------------
-- Resolves a reservation. p_kind null means no signal. Otherwise the interview's warning count is
-- incremented and an `integrity_warning` (kind and number only) is stored; the third terminates the
-- interview with `integrity_violation` and a `termination` event.
--
-- Returns (status, warning_number) where status is one of:
--   clear        resolved without a signal
--   warning      warning `warning_number` (1 or 2) was issued
--   terminated   the third warning ended the interview
--   not_active   the interview ended while the frame was analyzed; nothing was stored
-- A repeated call for an already-resolved check returns the first outcome.

create function public.record_integrity_signal(
  p_interview_id uuid,
  p_user_id uuid,
  p_check_id uuid,
  p_kind text
)
returns table (status text, warning_number integer)
language plpgsql
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_resolution public.interview_events;
  v_count integer;
begin
  if p_kind is not null and p_kind not in ('looking_away', 'other_person', 'device_or_notes', 'face_absent') then
    raise exception using errcode = '22023', message = 'invalid_integrity_signal';
  end if;

  perform pg_advisory_xact_lock(hashtext('interview_events'), hashtext(p_interview_id::text));

  if not exists (
    select 1 from public.interview_events as e
    where e.id = p_check_id
      and e.interview_id = p_interview_id
      and e.event_type = 'integrity_check'
      and not (e.payload ? 'check_id')
  ) then
    raise exception using errcode = 'P0002', message = 'integrity_check_not_found';
  end if;

  select * into v_resolution
  from public.interview_events as e
  where e.interview_id = p_interview_id
    and e.event_type in ('integrity_check', 'integrity_warning')
    and e.payload ->> 'check_id' = p_check_id::text;

  if found then
    if v_resolution.event_type = 'integrity_check' then
      return query select 'clear'::text, null::integer;
    else
      v_count := (v_resolution.payload ->> 'warning_number')::integer;
      return query select (case when v_count >= 3 then 'terminated' else 'warning' end)::text, v_count;
    end if;
    return;
  end if;

  if not exists (
    select 1 from public.interviews as i
    where i.id = p_interview_id and i.user_id = p_user_id and i.status = 'in_progress'
  ) then
    return query select 'not_active'::text, null::integer;
    return;
  end if;

  if p_kind is null then
    insert into public.interview_events (interview_id, user_id, sequence, event_type, payload)
    select p_interview_id, p_user_id, coalesce(max(e.sequence), 0) + 1, 'integrity_check',
      jsonb_build_object('check_id', p_check_id, 'outcome', 'clear')
    from public.interview_events as e
    where e.interview_id = p_interview_id;

    return query select 'clear'::text, null::integer;
    return;
  end if;

  update public.interviews as i
  set integrity_warning_count = i.integrity_warning_count + 1,
      last_active_at = now()
  where i.id = p_interview_id and i.user_id = p_user_id and i.status = 'in_progress'
  returning i.integrity_warning_count into v_count;

  insert into public.interview_events (interview_id, user_id, sequence, event_type, payload)
  select p_interview_id, p_user_id, coalesce(max(e.sequence), 0) + 1, 'integrity_warning',
    jsonb_build_object('check_id', p_check_id, 'kind', p_kind, 'warning_number', v_count)
  from public.interview_events as e
  where e.interview_id = p_interview_id;

  if v_count < 3 then
    return query select 'warning'::text, v_count;
    return;
  end if;

  update public.interviews as i
  set status = 'terminated',
      termination_reason = 'integrity_violation',
      ended_at = now()
  where i.id = p_interview_id;

  insert into public.interview_events (interview_id, user_id, sequence, event_type, payload)
  select p_interview_id, p_user_id, coalesce(max(e.sequence), 0) + 1, 'termination',
    '{"reason": "integrity_violation"}'::jsonb
  from public.interview_events as e
  where e.interview_id = p_interview_id;

  return query select 'terminated'::text, v_count;
end;
$$;

revoke execute on function public.record_integrity_signal(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.record_integrity_signal(uuid, uuid, uuid, text) to service_role;

-- record_voice_event: technical pause and resume ---------------------------------------------
-- Same contract as before, now also accepting `pause` (payload carries the reason) and `resume`.
-- They mark interruptions for history and integrity gating; voice time still comes from
-- connected / disconnected only.

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
  if p_event_type not in ('connected', 'disconnected', 'pause', 'resume') then
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
