-- request_report_upgrade ----------------------------------------------------
-- Queues a report_generation job that regenerates a legacy report (one stored before learning
-- reports, so its content has no report_version) for a completed interview. Returns the new job
-- id, or null when the interview is not the user's, is not completed, has no report, already has a
-- versioned report, or already has an active report job. The legacy report stays in place until
-- save_report replaces it, so a failed regeneration loses nothing.

create function public.request_report_upgrade(
  p_interview_id uuid,
  p_user_id uuid
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_interview public.interviews;
  v_job_id uuid;
begin
  select * into v_interview
  from public.interviews as i
  where i.id = p_interview_id
    and i.user_id = p_user_id
    and i.status = 'completed';

  if not found then
    return null;
  end if;

  if not exists (
    select 1
    from public.reports as r
    where r.interview_id = p_interview_id
      and r.user_id = p_user_id
      and not (r.content ? 'report_version')
  ) then
    return null;
  end if;

  insert into public.jobs (user_id, workspace_id, interview_id, type, status, repository_commit_sha)
  values (p_user_id, v_interview.workspace_id, p_interview_id, 'report_generation', 'queued', v_interview.repository_commit_sha)
  on conflict (interview_id) where type = 'report_generation' and status in ('queued', 'running') do nothing
  returning id into v_job_id;

  return v_job_id;
end;
$$;

revoke execute on function public.request_report_upgrade(uuid, uuid) from public, anon, authenticated;
grant execute on function public.request_report_upgrade(uuid, uuid) to service_role;
