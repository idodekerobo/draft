alter table source_connections
  drop constraint source_connections_provider_check;

alter table source_connections
  add constraint source_connections_provider_check
  check (provider in ('fireflies', 'slack', 'granola', 'linear', 'github', 'claude_session', 'codex_session', 'manual_upload'));

-- Global backstop: the existing unique(workspace_id, provider, connection_key)
-- only prevents duplicates within one workspace. Nothing else stops two
-- different workspaces from claiming the same GitHub installation_id.
-- Scoped to non-revoked rows so an uninstalled-then-reinstalled-elsewhere
-- installation can be re-bound later.
create unique index source_connections_github_installation_unique
  on source_connections (connection_key)
  where provider = 'github' and status <> 'revoked';
