-- Report generation (Inngest `interview.report.requested`, architecture section 12): one queued
-- report job per completed interview, and the report plus its job outcome stored atomically.

-- jobs ----------------------------------------------------------------------

alter table public.jobs
  drop constraint jobs_stage_check,
  add constraint jobs_stage_check
    check (stage is null or stage in ('scanning', 'analyzing', 'preparing_context', 'planning', 'reporting'));

-- At most one queued/running report run per interview.
create unique index jobs_active_report_generation_key
  on public.jobs (interview_id)
  where type = 'report_generation' and status in ('queued', 'running');

-- request_report ------------------------------------------------------------
-- Queues a report_generation job for a completed interview. Returns the new job id, or null when
-- the interview is not the user's, is not completed, already has a report, or already has an
-- active report job. Used both on completion and for retries after a failure.

create function public.request_report(
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

  if exists (select 1 from public.reports as r where r.interview_id = p_interview_id) then
    return null;
  end if;

  insert into public.jobs (user_id, workspace_id, interview_id, type, status, repository_commit_sha)
  values (p_user_id, v_interview.workspace_id, p_interview_id, 'report_generation', 'queued', v_interview.repository_commit_sha)
  on conflict (interview_id) where type = 'report_generation' and status in ('queued', 'running') do nothing
  returning id into v_job_id;

  return v_job_id;
end;
$$;

revoke execute on function public.request_report(uuid, uuid) from public, anon, authenticated;
grant execute on function public.request_report(uuid, uuid) to service_role;

-- save_report ---------------------------------------------------------------
-- Upserts the interview's report and marks its job succeeded in one transaction, so a retried
-- Inngest step never leaves a report without a finished job (or the reverse).
-- Errors (message is the code):
--   22023 invalid_report_content  content is not a JSON object
--   P0002 report_job_not_found    no report_generation job with this id for this interview

create function public.save_report(
  p_interview_id uuid,
  p_job_id uuid,
  p_content jsonb
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_interview public.interviews;
begin
  if p_content is null or jsonb_typeof(p_content) <> 'object' then
    raise exception using errcode = '22023', message = 'invalid_report_content';
  end if;

  select i.* into v_interview
  from public.jobs as j
  join public.interviews as i
    on i.id = j.interview_id and i.workspace_id = j.workspace_id and i.user_id = j.user_id
  where j.id = p_job_id
    and j.type = 'report_generation'
    and j.interview_id = p_interview_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'report_job_not_found';
  end if;

  insert into public.reports (interview_id, workspace_id, user_id, content)
  values (v_interview.id, v_interview.workspace_id, v_interview.user_id, p_content)
  on conflict (interview_id) do update
  set content = excluded.content,
      generated_at = now();

  update public.jobs
  set status = 'succeeded',
      progress = 100,
      stage = null,
      error_code = null,
      error_message = null,
      finished_at = now()
  where id = p_job_id;
end;
$$;

revoke execute on function public.save_report(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.save_report(uuid, uuid, jsonb) to service_role;
