-- Persistent repository memory (PRD section 23), pinned to an indexed commit.
-- Stores derived summaries only, never raw source.
-- Embedding dimension matches OpenAI text-embedding-3-small.

create table public.repository_memory (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  repository_id uuid not null,
  user_id uuid not null,
  repository_commit_sha public.git_commit_sha not null,
  kind text not null check (kind in (
    'architecture_summary',
    'technologies',
    'modules',
    'key_files',
    'concepts',
    'dependencies',
    'configuration',
    'file_summary'
  )),
  content text not null,
  structured jsonb not null default '{}'::jsonb,
  embedding extensions.vector(1536),
  token_count integer check (token_count >= 0),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Keeps the denormalized repository_id and user_id consistent with the owning workspace.
  foreign key (workspace_id, repository_id, user_id)
    references public.workspaces (id, repository_id, user_id)
    on delete cascade
);

create index repository_memory_workspace_commit_idx
  on public.repository_memory (workspace_id, repository_commit_sha);

create index repository_memory_workspace_fk_idx
  on public.repository_memory (workspace_id, repository_id, user_id);

create index repository_memory_user_id_idx on public.repository_memory (user_id);

create index repository_memory_embedding_idx
  on public.repository_memory
  using hnsw (embedding extensions.vector_cosine_ops);

create trigger repository_memory_set_updated_at
  before update on public.repository_memory
  for each row execute function public.set_updated_at();

-- Security invoker: RLS on repository_memory applies to the caller. Interview-time retrieval
-- must call this with a user-scoped client; the service role bypasses RLS.
create function public.match_repository_memory(
  p_workspace_id uuid,
  p_query_embedding extensions.vector(1536),
  p_commit_sha text,
  p_match_count integer default 10
)
returns table (
  id uuid,
  kind text,
  content text,
  structured jsonb,
  metadata jsonb,
  similarity double precision
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    m.id,
    m.kind,
    m.content,
    m.structured,
    m.metadata,
    1 - (m.embedding operator(extensions.<=>) p_query_embedding) as similarity
  from public.repository_memory as m
  where m.workspace_id = p_workspace_id
    and m.repository_commit_sha = p_commit_sha
    and m.embedding is not null
  order by m.embedding operator(extensions.<=>) p_query_embedding
  limit least(greatest(coalesce(p_match_count, 10), 1), 50);
$$;

revoke execute on function public.match_repository_memory(uuid, extensions.vector, text, integer)
  from public, anon;
grant execute on function public.match_repository_memory(uuid, extensions.vector, text, integer)
  to authenticated, service_role;
