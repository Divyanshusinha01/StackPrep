-- Row level security and explicit grants.
-- Clients only read their own rows (plus updating their own profile). All other writes go
-- through Edge Functions / Inngest using the service role.
-- interview_state and evaluations have no client grants and no policies, so they fail closed.

-- Reset grants -----------------------------------------------------------------

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;

grant all on all tables in schema public to service_role;

grant select on
  public.profiles,
  public.github_connections,
  public.repositories,
  public.workspaces,
  public.repository_memory,
  public.interviews,
  public.interview_messages,
  public.interview_events,
  public.reports,
  public.jobs
to authenticated;

grant update (display_name, avatar_url) on public.profiles to authenticated;

grant execute on function public.match_repository_memory(uuid, extensions.vector, text, integer)
  to authenticated, service_role;
grant execute on function public.create_interview(uuid, uuid, text, jsonb, jsonb, jsonb) to service_role;
grant execute on function public.update_interview_state(uuid, bigint, jsonb, jsonb, jsonb) to service_role;

-- Enable RLS on every table ----------------------------------------------------

alter table public.profiles enable row level security;
alter table public.github_connections enable row level security;
alter table public.repositories enable row level security;
alter table public.workspaces enable row level security;
alter table public.repository_memory enable row level security;
alter table public.interviews enable row level security;
alter table public.interview_state enable row level security;
alter table public.interview_messages enable row level security;
alter table public.interview_events enable row level security;
alter table public.evaluations enable row level security;
alter table public.reports enable row level security;
alter table public.jobs enable row level security;

-- Owner policies ---------------------------------------------------------------
-- (select auth.uid()) is evaluated once per statement instead of once per row.

create policy "Users can read their own profile"
  on public.profiles for select to authenticated
  using (id = (select auth.uid()));

create policy "Users can update their own profile"
  on public.profiles for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

create policy "Users can read their own GitHub connections"
  on public.github_connections for select to authenticated
  using (user_id = (select auth.uid()));

create policy "Users can read their own repositories"
  on public.repositories for select to authenticated
  using (user_id = (select auth.uid()));

create policy "Users can read their own workspaces"
  on public.workspaces for select to authenticated
  using (user_id = (select auth.uid()));

create policy "Users can read their own repository memory"
  on public.repository_memory for select to authenticated
  using (user_id = (select auth.uid()));

create policy "Users can read their own interviews"
  on public.interviews for select to authenticated
  using (user_id = (select auth.uid()));

create policy "Users can read their own interview messages"
  on public.interview_messages for select to authenticated
  using (user_id = (select auth.uid()));

create policy "Users can read their own interview events"
  on public.interview_events for select to authenticated
  using (user_id = (select auth.uid()));

create policy "Users can read their own reports"
  on public.reports for select to authenticated
  using (user_id = (select auth.uid()));

create policy "Users can read their own jobs"
  on public.jobs for select to authenticated
  using (user_id = (select auth.uid()));
