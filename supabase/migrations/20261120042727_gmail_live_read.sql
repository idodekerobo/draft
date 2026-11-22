-- Gmail is read live with the owner's own login and nothing is stored, so the old Gmail sync and Drive
-- ledger objects go away. Each drop is guarded because only staging ever had them.
drop function if exists claim_pending_gmail_messages(uuid, int, int);
drop function if exists upsert_drive_source_item(uuid, uuid, text, text, timestamptz, text, text, jsonb, jsonb, uuid);
drop table if exists gmail_messages;
drop table if exists drive_files;
alter table workspaces drop column if exists brain_policy;

-- A person's private Gmail connection.
alter table connections drop constraint if exists connections_provider_check;
alter table connections add constraint connections_provider_check
  check (provider in ('fireflies', 'slack', 'granola', 'linear', 'github', 'gmail', 'claude_session', 'codex_session', 'manual_upload', 'mcp'));

-- A connect link for the Google sign-in. One request covers every Google product the person grants.
alter table connection_requests drop constraint if exists connection_requests_provider_check;
alter table connection_requests add constraint connection_requests_provider_check
  check (provider in ('fireflies', 'slack', 'granola', 'linear', 'github', 'google', 'claude_session', 'codex_session', 'manual_upload', 'mcp'));
