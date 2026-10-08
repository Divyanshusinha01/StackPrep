-- DELETE /interviews/:id: the candidate removes an ended interview from their history.
--
-- The row is kept and marked with deleted_at, because the 5-per-24h limit, interview numbering,
-- ai_usage and planning memory all read interview rows, and children cascade on a hard delete.
-- RLS hides a deleted interview and its messages, events, reports and jobs from the owner;
-- service-role readers are not affected.

alter table public.interviews add column deleted_at timestamptz;

-- Owner policies -----------------------------------------------------------------------------

drop policy "Users can read their own interviews" on public.interviews;
create policy "Users can read their own interviews"
  on public.interviews for select to authenticated
  using (user_id = (select auth.uid()) and deleted_at is null);

drop policy "Users can read their own interview messages" on public.interview_messages;
create policy "Users can read their own interview messages"
  on public.interview_messages for select to authenticated
  using (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.interviews as i
      where i.id = interview_id and i.deleted_at is null
    )
  );

drop policy "Users can read their own interview events" on public.interview_events;
create policy "Users can read their own interview events"
  on public.interview_events for select to authenticated
  using (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.interviews as i
      where i.id = interview_id and i.deleted_at is null
    )
  );

drop policy "Users can read their own reports" on public.reports;
create policy "Users can read their own reports"
  on public.reports for select to authenticated
  using (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.interviews as i
      where i.id = interview_id and i.deleted_at is null
    )
  );

drop policy "Users can read their own jobs" on public.jobs;
create policy "Users can read their own jobs"
  on public.jobs for select to authenticated
  using (
    user_id = (select auth.uid())
    and (
      interview_id is null
      or exists (
        select 1 from public.interviews as i
        where i.id = interview_id and i.deleted_at is null
      )
    )
  );

-- delete_interview ---------------------------------------------------------------------------
-- Returns one of:
--   deleted          deleted_at is now set
--   already_deleted  it was already deleted; nothing was written
--   not_ended        it is still pending, in progress or paused
--   not_found        no interview with this id belongs to the user
--
-- Takes the per-interview interview_events advisory lock shared by every event writer, so it
-- cannot interleave with an end or pause of the same interview.

create function public.delete_interview(
  p_interview_id uuid,
  p_user_id uuid
)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_interview public.interviews;
begin
  perform pg_advisory_xact_lock(hashtext('interview_events'), hashtext(p_interview_id::text));

  select * into v_interview
  from public.interviews as i
  where i.id = p_interview_id and i.user_id = p_user_id
  for update;

  if not found then
    return 'not_found';
  end if;

  if v_interview.deleted_at is not null then
    return 'already_deleted';
  end if;

  if v_interview.status not in ('completed', 'terminated', 'failed') then
    return 'not_ended';
  end if;

  update public.interviews as i
  set deleted_at = now()
  where i.id = p_interview_id;

  return 'deleted';
end;
$$;

revoke execute on function public.delete_interview(uuid, uuid) from public, anon, authenticated;
grant execute on function public.delete_interview(uuid, uuid) to service_role;
