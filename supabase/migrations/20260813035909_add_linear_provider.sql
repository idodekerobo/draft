alter table source_connections
  drop constraint source_connections_provider_check;

alter table source_connections
  add constraint source_connections_provider_check
  check (provider in ('fireflies', 'slack', 'granola', 'linear', 'claude_session', 'codex_session', 'manual_upload'));
