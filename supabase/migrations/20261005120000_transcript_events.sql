-- POST /interviews/:id/events: idempotent transcript turns and connected/disconnected events
-- reported by the browser (architecture "Transcript persistence").
--
-- The browser supplies only a client_event_id; both functions assign the next sequence for the
-- interview under a per-interview advisory lock, so a client that lost its local state (cleared
-- storage, another device) can never collide with turns already stored.
--
-- Both return (status, sequence) where status is one of:
--   created         a new row was stored at `sequence`
--   duplicate       the client_event_id was already stored with the same payload at `sequence`
--   event_conflict  the client_event_id was already used for a different payload

-- interview_events.client_event_id ----------------------------------------------
-- Null for server-written events; set for every event the browser reports.

alter table public.interview_events
  add column client_event_id uuid;

create unique index interview_events_client_event_id_key
  on public.interview_events (interview_id, client_event_id)
  where client_event_id is not null;

-- record_transcript_turn -----------------------------------------------------------

create function public.record_transcript_turn(
  p_interview_id uuid,
  p_user_id uuid,
  p_client_event_id uuid,
  p_role public.message_role,
  p_content text,
  p_metadata jsonb
)
returns table (status text, sequence integer)
language plpgsql
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_existing public.interview_messages;
  v_sequence integer;
begin
  if p_role not in ('ai', 'user') then
    raise exception using errcode = '22023', message = 'invalid_transcript_role';
  end if;

  -- Serializes turn sequence assignment per interview.
  perform pg_advisory_xact_lock(hashtext('interview_messages'), hashtext(p_interview_id::text));

  select * into v_existing
  from public.interview_messages as m
  where m.interview_id = p_interview_id
    and m.client_event_id = p_client_event_id;

  if found then
    if v_existing.role = p_role and v_existing.content = p_content then
      return query select 'duplicate'::text, v_existing.sequence;
    else
      return query select 'event_conflict'::text, v_existing.sequence;
    end if;
    return;
  end if;

  select coalesce(max(m.sequence), 0) + 1 into v_sequence
  from public.interview_messages as m
  where m.interview_id = p_interview_id;

  insert into public.interview_messages (interview_id, user_id, sequence, role, content, metadata, client_event_id)
  values (p_interview_id, p_user_id, v_sequence, p_role, p_content, coalesce(p_metadata, '{}'::jsonb), p_client_event_id);

  return query select 'created'::text, v_sequence;
end;
$$;

revoke execute on function public.record_transcript_turn(uuid, uuid, uuid, public.message_role, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.record_transcript_turn(uuid, uuid, uuid, public.message_role, text, jsonb)
  to service_role;

-- record_voice_event ---------------------------------------------------------------
-- occurred_at is the server's time; the browser's clock only goes into the payload, so it
-- cannot shorten measured voice time.

create function public.record_voice_event(
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

  return query select 'created'::text, v_sequence;
end;
$$;

revoke execute on function public.record_voice_event(uuid, uuid, uuid, public.event_type, jsonb)
  from public, anon, authenticated;
grant execute on function public.record_voice_event(uuid, uuid, uuid, public.event_type, jsonb)
  to service_role;
