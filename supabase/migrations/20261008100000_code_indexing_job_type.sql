-- Code indexing jobs (Inngest `repository.code_index.requested`). Kept separate from the
-- functions and indexes that reference the value: new enum values cannot be used in the
-- transaction that adds them.

alter type public.job_type add value if not exists 'code_indexing';
