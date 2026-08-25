-- Introduces `session_projects` (one row per project a workspace has ever
-- run `draft sessions enable` in) and widens `credentials`/`agent_sessions`
-- with a nullable `session_project_id` so a session-ingest credential can be
-- scoped to one project + one set of allowed providers instead of an entire
-- workspace. Nullable is deliberate: a null `session_project_id` on
-- `credentials` is how the ingest route detects a legacy credential and
-- falls back to today's workspace-scoped behavior for it -- no backfill,
-- no forced rotation.

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

-- Same access shape as `credentials`: RLS on, zero `authenticated`
-- policies, service role only. See db/schemas/credentials.sql's comment.
alter table session_projects enable row level security;

grant select on table session_projects to service_role;

-- Composite FKs against session_projects(id, workspace_id) (rather than a
-- plain FK on id) guarantee a credential/session can never point at a
-- session_project belonging to a different workspace than its own
-- workspace_id -- same defensive pattern already used for
-- agent_sessions.contributor_id -> session_contributors(id, workspace_id).

alter table credentials
  add column session_project_id uuid,
  add column allowed_providers text[],
  add constraint credentials_session_project_workspace_fk
    foreign key (session_project_id, workspace_id)
    references session_projects(id, workspace_id);

-- `credentials.provider` has no DB CHECK constraint by design (see
-- db/schemas/credentials.sql) -- adding the new 'agent_session_ingest'
-- provider value is a TS-only change (backend/src/types/enums.ts), same
-- pattern as the original 'claude_session_ingest' addition.

alter table agent_sessions
  add column session_project_id uuid,
  add constraint agent_sessions_session_project_workspace_fk
    foreign key (session_project_id, workspace_id)
    references session_projects(id, workspace_id);
