-- Evaluations (internal), reports, and the jobs status read-model.

-- evaluations ---------------------------------------------------------------
-- Internal per-answer scoring (PRD sections 7, 25). Never granted to clients and there is
-- no overall score (PRD section 26).

create table public.evaluations (
  id uuid primary key default gen_random_uuid(),
  interview_id uuid not null,
  user_id uuid not null,
  message_id uuid not null,
  category text not null,
  score smallint check (score between 1 and 5),
  rating text check (rating in ('strong', 'proficient', 'developing', 'weak', 'insufficient_evidence')),
  strengths jsonb not null default '[]'::jsonb check (jsonb_typeof(strengths) = 'array'),
  gaps jsonb not null default '[]'::jsonb check (jsonb_typeof(gaps) = 'array'),
  repo_evidence jsonb not null default '[]'::jsonb check (jsonb_typeof(repo_evidence) = 'array'),
  discrepancy boolean not null default false,
  discrepancy_detail text,
  created_at timestamptz not null default now(),
  foreign key (interview_id, user_id)
    references public.interviews (id, user_id)
    on delete cascade,
  -- The evaluated message must belong to the same interview.
  foreign key (message_id, interview_id)
    references public.interview_messages (id, interview_id)
    on delete cascade,
  check (discrepancy or discrepancy_detail is null)
);

create index evaluations_user_id_idx on public.evaluations (user_id);
create index evaluations_interview_user_idx on public.evaluations (interview_id, user_id);
create index evaluations_message_idx on public.evaluations (message_id, interview_id);

-- reports -------------------------------------------------------------------

create table public.reports (
  id uuid primary key default gen_random_uuid(),
  interview_id uuid not null unique,
  workspace_id uuid not null,
  user_id uuid not null,
  -- PRD section 26 structure: executive summary, category evaluations, strengths, gaps,
  -- interview evidence, repository evidence, areas to improve, transcript.
  content jsonb not null check (jsonb_typeof(content) = 'object'),
  storage_path text,
  generated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (interview_id, workspace_id, user_id)
    references public.interviews (id, workspace_id, user_id)
    on delete cascade
);

create index reports_user_id_idx on public.reports (user_id);
create index reports_workspace_id_idx on public.reports (workspace_id);
create index reports_interview_fk_idx on public.reports (interview_id, workspace_id, user_id);

create trigger reports_set_updated_at
  before update on public.reports
  for each row execute function public.set_updated_at();

-- jobs ----------------------------------------------------------------------
-- Read-model of Inngest job status/progress for the UI. Not a queue: written only by Inngest
-- functions (service role) as projections of their own steps; nothing polls or claims rows.

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  workspace_id uuid not null,
  interview_id uuid,
  type public.job_type not null,
  status public.job_status not null default 'queued',
  progress smallint not null default 0 check (progress between 0 and 100),
  stage text,
  inngest_event_id text,
  inngest_run_id text,
  error_message text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (workspace_id, user_id)
    references public.workspaces (id, user_id)
    on delete cascade,
  foreign key (interview_id, workspace_id, user_id)
    references public.interviews (id, workspace_id, user_id)
    on delete cascade,
  check (type <> 'report_generation' or interview_id is not null),
  check (status <> 'failed' or error_message is not null)
);

create unique index jobs_inngest_run_id_key on public.jobs (inngest_run_id) where inngest_run_id is not null;
create index jobs_user_id_idx on public.jobs (user_id);
create index jobs_workspace_user_idx on public.jobs (workspace_id, user_id);
create index jobs_interview_fk_idx on public.jobs (interview_id, workspace_id, user_id)
  where interview_id is not null;

create trigger jobs_set_updated_at
  before update on public.jobs
  for each row execute function public.set_updated_at();
