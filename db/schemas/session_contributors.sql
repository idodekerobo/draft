create table session_contributors (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references workspaces(id) on delete cascade,
  git_email         text not null,
  git_display_name  text,
  claimed_user_id   uuid references users(id) on delete set null,
  first_seen_at     timestamptz not null default now(),
  last_seen_at      timestamptz not null default now(),

  unique (workspace_id, git_email),
  unique (id, workspace_id)
);

alter table session_contributors enable row level security;

create policy session_contributors_select on session_contributors
  for select to authenticated
  using (
    exists (
      select 1 from workspaces w
      where w.id = session_contributors.workspace_id
        and w.organization_id = current_user_org_id()
        and w.team_id = current_user_team_id()
        and w.access_mode = 'team_default'
    )
  );

grant select on table session_contributors to authenticated;
grant select, insert, update on table session_contributors to service_role;
