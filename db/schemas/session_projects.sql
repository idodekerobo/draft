-- One row per project a workspace has ever run `draft sessions enable` in.
-- `project_key` is the random UUID minted client-side into the repo's
-- committed .claude/draft/config.json -- stability across clones comes from
-- git tracking that file, not from git-remote normalization. Same access
-- shape as `credentials`: RLS on, zero `authenticated` policies, service
-- role only.
create table session_projects (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  project_key   text not null,
  label         text,
  status        text not null default 'active'
                  check (status in ('active', 'archived')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  unique (workspace_id, project_key),
  unique (id, workspace_id)
);

create trigger session_projects_set_updated_at
  before update on session_projects
  for each row execute function set_updated_at();

alter table session_projects enable row level security;

grant select on table session_projects to service_role;
