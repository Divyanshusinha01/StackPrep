-- Realtime voice interview events. Kept separate from the indexes that reference these values:
-- new enum values cannot be used in the transaction that adds them.

alter type public.event_type add value if not exists 'tool_call';
alter type public.event_type add value if not exists 'connected';
alter type public.event_type add value if not exists 'disconnected';
