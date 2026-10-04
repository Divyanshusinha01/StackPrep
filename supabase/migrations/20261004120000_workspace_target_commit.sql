-- Commit selected for indexing when the workspace is created. indexed_commit_sha stays null until
-- indexing finishes, so status = 'ready' and repository_memory pinning keep their meaning.

alter table public.workspaces add column target_commit_sha public.git_commit_sha;
