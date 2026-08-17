-- Add a 'manual_upload' provider so onboarding can seed a brand-new
-- workspace's first synthesis run from files uploaded straight from the
-- desktop app, without waiting on Slack/Fireflies to produce ready items.

alter table source_connections drop constraint source_connections_provider_check;

alter table source_connections add constraint source_connections_provider_check
  check (provider in ('fireflies', 'slack', 'granola', 'claude_session', 'codex_session', 'manual_upload', 'reserved_other'));
