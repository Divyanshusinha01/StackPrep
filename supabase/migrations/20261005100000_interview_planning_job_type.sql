-- Interview planning jobs (Inngest `interview.planning.requested`). Kept separate from the
-- function and indexes that reference the value: new enum values cannot be used in the
-- transaction that adds them.

alter type public.job_type add value if not exists 'interview_planning';
