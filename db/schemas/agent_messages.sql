-- Immutable feed, no updated_at: the ingestion hook deletes and reinserts
-- the full message set for a session rather than mutating rows in place.
create table agent_messages (
  id           uuid primary key default gen_random_uuid(),
  session_id   uuid not null,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  seq          int not null,
  role         text not null,
  content      text not null,
  created_at   timestamptz not null default now(),

  -- Composite FK, matching the pattern source_items already uses for its
  -- own workspace_id: keeps RLS a single-table predicate with no join,
  -- while making a message's workspace_id drift from its session's
  -- unrepresentable rather than merely unlikely.
  foreign key (session_id, workspace_id)
    references agent_sessions(id, workspace_id) on delete cascade
);

create index agent_messages_session_id_seq_idx on agent_messages (session_id, seq);

alter table agent_messages enable row level security;

create policy agent_messages_select on agent_messages
  for select to authenticated
  using (
    exists (
      select 1 from workspaces w
      where w.id = agent_messages.workspace_id
        and w.organization_id = current_user_org_id()
        and w.team_id = current_user_team_id()
        and w.access_mode = 'team_default'
    )
  );

grant select on table agent_messages to authenticated;
grant select, insert, delete on table agent_messages to service_role;
