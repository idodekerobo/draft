create table agent_sessions (
  id                    uuid primary key default gen_random_uuid(),
  workspace_id          uuid not null references workspaces(id) on delete cascade,
  provider              text not null,          -- claude-code | hermes | opencode | ...
  user_id               uuid references users(id),                 -- authenticated path
  contributor_id        uuid references session_contributors(id),  -- fallback path
  external_session_id   text not null,           -- provider's own session id
  project               text,
  cwd                   text,
  started_at            timestamptz not null,
  ended_at              timestamptz,
  status                text not null,
  -- Summarization lease + retry state. An attempt timestamp alone is a
  -- lease with no expiry: a worker that dies mid-run would wedge the
  -- session forever without summary_lease_until.
  summary_status        text not null default 'pending'
                          check (summary_status in ('pending', 'leased', 'ok', 'failed', 'skipped')),
  summary_attempts      int not null default 0,
  summary_lease_until   timestamptz,
  summary_last_error    text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  check (num_nonnulls(user_id, contributor_id) = 1),
  foreign key (contributor_id, workspace_id)
    references session_contributors(id, workspace_id) on delete restrict,
  unique (workspace_id, provider, external_session_id),
  unique (id, workspace_id)
);

create trigger agent_sessions_set_updated_at
  before update on agent_sessions
  for each row execute function set_updated_at();

alter table agent_sessions enable row level security;

create policy agent_sessions_select on agent_sessions
  for select to authenticated
  using (
    exists (
      select 1 from workspaces w
      where w.id = agent_sessions.workspace_id
        and w.organization_id = current_user_org_id()
        and w.team_id = current_user_team_id()
        and w.access_mode = 'team_default'
    )
  );

grant select on table agent_sessions to authenticated;
grant select, insert, update on table agent_sessions to service_role;
