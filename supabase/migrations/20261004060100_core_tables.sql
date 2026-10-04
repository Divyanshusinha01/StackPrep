-- Users, GitHub connections, repositories, and workspaces.
-- Ownership: profile -> github_connection -> repository -> workspace (one per repository).

-- Full Git commit SHA (SHA-1, or SHA-256 for repositories using the newer object format).
create domain public.git_commit_sha as text
  check (value ~ '^[0-9a-f]{40}([0-9a-f]{24})?$');

-- profiles ------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  github_login text,
  display_name text check (char_length(display_name) <= 200),
  avatar_url text check (char_length(avatar_url) <= 2048),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- Runs as the auth service role during sign-up, so it must bypass RLS on profiles.
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, github_login, display_name, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'user_name', new.raw_user_meta_data ->> 'preferred_username'),
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- github_connections ----------------------------------------------------------
-- No tokens are stored: GitHub App installation tokens are minted on demand server-side.

create table public.github_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  github_user_id bigint not null,
  installation_id bigint not null,
  account_login text not null,
  account_type text check (account_type in ('User', 'Organization')),
  repository_selection text check (repository_selection in ('all', 'selected')),
  permissions jsonb not null default '{}'::jsonb check (jsonb_typeof(permissions) = 'object'),
  suspended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, installation_id),
  unique (id, user_id)
);

create trigger github_connections_set_updated_at
  before update on public.github_connections
  for each row execute function public.set_updated_at();

-- repositories --------------------------------------------------------------

create table public.repositories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  github_connection_id uuid,
  github_repo_id bigint not null,
  owner text not null,
  name text not null,
  full_name text not null,
  is_private boolean not null,
  default_branch text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, github_repo_id),
  unique (id, user_id),
  -- A repository outlives its connection (the workspace is permanent), but can only point
  -- at a connection owned by the same user.
  foreign key (github_connection_id, user_id)
    references public.github_connections (id, user_id)
    on delete set null (github_connection_id)
);

create index repositories_github_connection_id_idx on public.repositories (github_connection_id, user_id);

create trigger repositories_set_updated_at
  before update on public.repositories
  for each row execute function public.set_updated_at();

-- workspaces ----------------------------------------------------------------

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  repository_id uuid not null unique,
  status public.workspace_status not null default 'analyzing',
  indexed_commit_sha public.git_commit_sha,
  ready_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id),
  unique (id, repository_id, user_id),
  foreign key (repository_id, user_id)
    references public.repositories (id, user_id)
    on delete cascade,
  check (status <> 'ready' or (ready_at is not null and indexed_commit_sha is not null))
);

create index workspaces_user_id_idx on public.workspaces (user_id);
create index workspaces_repository_id_user_id_idx on public.workspaces (repository_id, user_id);

create trigger workspaces_set_updated_at
  before update on public.workspaces
  for each row execute function public.set_updated_at();
