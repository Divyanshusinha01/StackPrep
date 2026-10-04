-- Extensions, enums, shared trigger functions, and default privileges.

-- New objects in public start with no client grants; each table/function is granted explicitly
-- in the RLS migration. service_role keeps Supabase's default grants.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from public, anon, authenticated;

create extension if not exists vector with schema extensions;

create type public.interview_status as enum (
  'created',
  'in_progress',
  'paused',
  'completed',
  'terminated',
  'failed'
);

create type public.termination_reason as enum (
  'integrity_violation',
  'completed_early',
  'time_limit',
  'technical_failure',
  'user_abandoned'
);

create type public.workspace_status as enum ('analyzing', 'ready', 'failed');

create type public.job_type as enum ('repository_indexing', 'deep_analysis', 'report_generation');

create type public.job_status as enum ('queued', 'running', 'succeeded', 'failed');

create type public.message_role as enum ('ai', 'user', 'system');

create type public.event_type as enum (
  'start',
  'integrity_warning',
  'pause',
  'resume',
  'termination',
  'completion',
  'evidence_examined'
);

create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

revoke execute on function public.set_updated_at() from public, anon, authenticated;
