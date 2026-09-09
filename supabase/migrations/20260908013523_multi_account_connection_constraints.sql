-- Multi-account providers (fireflies): each teammate connects their own
-- account, so a workspace ends up with N rows -- one per connecting user,
-- ever (revoke-then-reconnect rotates the same row rather than inserting a
-- new one, matching the app's lookup-by-connected_by_user_id logic). A plain
-- (not status-filtered) unique index closes the TOCTOU race where two
-- near-simultaneous connect requests from the same user both see "no
-- existing row" and both try to insert.
create unique index source_connections_one_per_connecting_user
  on source_connections (workspace_id, provider, connected_by_user_id)
  where provider = 'fireflies';

-- Singleton providers going through the generic connect route (Slack,
-- Linear, claude_session) may only ever have one live connection per
-- workspace -- app logic already assumes this, but nothing enforced it at
-- the database level. Same pattern as
-- source_connections_one_live_github_per_workspace.
create unique index source_connections_one_live_singleton_per_workspace
  on source_connections (workspace_id, provider)
  where provider in ('slack', 'linear', 'claude_session') and status <> 'revoked';
