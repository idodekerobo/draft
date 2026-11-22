-- A one-time link an agent asks for, so the person it works for can connect a provider in the app.
-- The agent never sees the key: the person enters it on the page the link opens. Only a hash of the
-- link's token is stored, and the link works once, for the person who asked, until it expires.
create table connection_requests (
  id                    uuid primary key default gen_random_uuid(),
  workspace_id          uuid not null references workspaces(id) on delete cascade,
  requested_by_user_id  uuid not null references users(id) on delete cascade,
  provider              text not null
                          check (provider in ('fireflies', 'slack', 'granola', 'linear', 'github', 'google', 'claude_session', 'codex_session', 'manual_upload', 'mcp')),
  token_hash            text not null unique,
  status                text not null default 'pending' check (status in ('pending', 'completed')),
  created_via           text not null check (created_via in ('mcp', 'cli', 'http')),
  expires_at            timestamptz not null,
  completed_at          timestamptz,
  created_at            timestamptz not null default now()
);

create index connection_requests_requester_idx on connection_requests (workspace_id, requested_by_user_id, created_at desc);

-- Only the backend reads or writes it.
alter table connection_requests enable row level security;
grant select, insert, update on table connection_requests to service_role;
