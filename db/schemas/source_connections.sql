create table source_connections (
  id                       uuid primary key default gen_random_uuid(),
  workspace_id             uuid not null references workspaces(id) on delete cascade,
  provider                 text not null
                              check (provider in ('fireflies', 'slack', 'granola', 'linear', 'github', 'claude_session', 'codex_session', 'manual_upload')),
  connection_key           text not null,
  display_name             text,
  external_account_id      text,
  status                   text not null default 'pending'
                              check (status in ('pending', 'active', 'degraded', 'revoked', 'error')),
  credential_id            uuid,
  config_json              jsonb not null default '{}',
  cursor_json              jsonb not null default '{}',
  connected_by_user_id     uuid references users(id) on delete set null,
  last_success_at          timestamptz,
  last_error_at            timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  unique (workspace_id, provider, connection_key),
  unique (id, workspace_id),
  foreign key (credential_id, workspace_id)
    references credentials(id, workspace_id) on delete restrict
);

-- Global backstop: unique(workspace_id, provider, connection_key) above only
-- prevents duplicates within one workspace. Nothing else stops two different
-- workspaces from claiming the same GitHub installation_id. Scoped to
-- non-revoked rows so an uninstalled-then-reinstalled-elsewhere installation
-- can be re-bound later.
create unique index source_connections_github_installation_unique
  on source_connections (connection_key)
  where provider = 'github' and status <> 'revoked';

alter table source_connections enable row level security;

create policy source_connections_select on source_connections
  for select to authenticated
  using (
    exists (
      select 1 from workspaces w
      where w.id = source_connections.workspace_id
        and w.organization_id = current_user_org_id()
        and w.team_id = current_user_team_id()
        and w.access_mode = 'team_default'
    )
  );

grant select on table source_connections to authenticated;
grant select, insert, update on table source_connections to service_role;
