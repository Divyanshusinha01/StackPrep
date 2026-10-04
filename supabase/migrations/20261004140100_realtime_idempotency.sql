-- Idempotent transcript turns and tool calls relayed by the browser.

-- The events API always supplies client_event_id; the default only covers server-written rows.
alter table public.interview_messages
  add column client_event_id uuid not null default gen_random_uuid();

alter table public.interview_messages
  add constraint interview_messages_interview_client_event_key unique (interview_id, client_event_id);

create unique index interview_events_tool_call_id_key
  on public.interview_events (interview_id, (payload ->> 'call_id'))
  where event_type = 'tool_call';

alter table public.interview_events
  add constraint interview_events_tool_call_has_call_id
  check (event_type <> 'tool_call' or nullif(payload ->> 'call_id', '') is not null);
